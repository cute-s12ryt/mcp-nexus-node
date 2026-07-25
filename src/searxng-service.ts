import { z } from "zod";

import type { WebSearchSettings, WebSearchSource } from "./app-state.js";
import { assertSafeRemoteUrl } from "./network-policy.js";

const resultSchema = z.object({
  title: z.string().default("Untitled result"),
  url: z.string().url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol), "搜尋結果網址必須使用 HTTP 或 HTTPS"),
  content: z.string().optional().default(""),
  engine: z.string().optional(),
  engines: z.array(z.string()).optional(),
});

const responseSchema = z.object({
  results: z.array(resultSchema).default([]),
});

const engineBySource: Partial<Record<WebSearchSource, string>> = {
  google: "google",
  bing: "bing",
  duckduckgo: "duckduckgo",
  startpage: "startpage",
};

export class WebSearchConfigurationError extends Error {}

export class SearxngSearchError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface WebSearchResultItem {
  title: string;
  url: string;
  snippet: string;
  sources: WebSearchSource[];
  engines: string[];
}

export interface WebSearchFailure {
  source: WebSearchSource;
  error: string;
}

export interface WebSearchEvidence {
  mode: WebSearchSettings["mode"];
  sources: WebSearchSource[];
  results: WebSearchResultItem[];
  failures: WebSearchFailure[];
}

export class SearxngSearchService {
  constructor(
    private readonly maxResponseBytes = 1024 * 1024,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async search(query: string, settings: WebSearchSettings): Promise<WebSearchEvidence> {
    if (!settings.endpoint) throw new WebSearchConfigurationError("請先在搜尋調度頁設定自架 SearXNG 服務網址");
    const safeBaseUrl = await assertSafeRemoteUrl(settings.endpoint);
    const searches = await mapWithConcurrency(settings.sources, 2, async (source) => {
      try {
        return { source, results: await this.searchSource(query, source, settings, safeBaseUrl) };
      } catch (error) {
        return { source, error: errorMessage(error) };
      }
    });
    const failures: WebSearchFailure[] = searches
      .filter((entry): entry is { source: WebSearchSource; error: string } => "error" in entry)
      .map(({ source, error }) => ({ source, error }));
    const successful = searches.filter((entry): entry is { source: WebSearchSource; results: WebSearchResultItem[] } => "results" in entry);
    if (successful.length === 0) {
      throw new SearxngSearchError(`所有 SearXNG 搜尋來源均失敗：${failures.map(({ source, error }) => `${source}: ${error}`).join("；")}`);
    }
    return {
      mode: settings.mode,
      sources: [...settings.sources],
      results: deduplicateResults(successful.flatMap(({ results }) => results)),
      failures,
    };
  }

  private async searchSource(
    query: string,
    source: WebSearchSource,
    settings: WebSearchSettings,
    safeBaseUrl: URL,
  ): Promise<WebSearchResultItem[]> {
    const endpoint = searchEndpoint(safeBaseUrl);
    endpoint.searchParams.set("q", query);
    endpoint.searchParams.set("format", "json");
    endpoint.searchParams.set("language", settings.language);
    endpoint.searchParams.set("safesearch", String(settings.safeSearch));
    const engine = engineBySource[source];
    if (engine) endpoint.searchParams.set("engines", engine);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await this.fetcher(endpoint, {
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: controller.signal,
      });
      const raw = await readLimitedText(response, this.maxResponseBytes, controller);
      if (!response.ok) {
        const jsonHint = response.status === 403 ? "；請確認 SearXNG settings.yml 的 search.formats 已啟用 json" : "";
        throw new SearxngSearchError(`SearXNG 回應 HTTP ${response.status}${jsonHint}`, response.status);
      }
      let parsed: z.infer<typeof responseSchema>;
      try {
        parsed = responseSchema.parse(JSON.parse(raw));
      } catch (error) {
        throw new SearxngSearchError(`SearXNG JSON 回應格式無效：${error instanceof Error ? error.message : "Unknown parse error"}`);
      }
      return parsed.results.slice(0, settings.resultsPerSource).map((result) => ({
        title: result.title.trim().slice(0, 500) || "Untitled result",
        url: result.url,
        snippet: result.content.trim().slice(0, 2_000),
        sources: [source],
        engines: [...new Set([...(result.engines ?? []), ...(result.engine ? [result.engine] : [])])].slice(0, 10),
      }));
    } catch (error) {
      if (controller.signal.aborted && !(error instanceof SearxngSearchError)) {
        throw new SearxngSearchError("SearXNG 請求逾時或回應超過大小上限");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function searchEndpoint(baseUrl: URL): URL {
  const endpoint = new URL(baseUrl.href);
  const pathname = endpoint.pathname.replace(/\/+$/, "");
  endpoint.pathname = pathname.endsWith("/search") ? pathname : `${pathname}/search`;
  endpoint.hash = "";
  return endpoint;
}

function deduplicateResults(results: WebSearchResultItem[]): WebSearchResultItem[] {
  const unique = new Map<string, WebSearchResultItem>();
  for (const result of results) {
    const key = canonicalUrl(result.url);
    const existing = unique.get(key);
    if (!existing) {
      unique.set(key, { ...result, url: key });
      continue;
    }
    existing.sources = [...new Set([...existing.sources, ...result.sources])];
    existing.engines = [...new Set([...existing.engines, ...result.engines])].slice(0, 10);
    if (result.snippet.length > existing.snippet.length) existing.snippet = result.snippet;
  }
  return [...unique.values()];
}

function canonicalUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.hash = "";
  for (const name of [...url.searchParams.keys()]) {
    if (/^(?:utm_.+|fbclid|gclid|mc_cid|mc_eid)$/i.test(name)) url.searchParams.delete(name);
  }
  url.searchParams.sort();
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = "";
  url.hostname = url.hostname.toLowerCase();
  return url.href;
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index] as T);
    }
  }));
  return results;
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
}

async function readLimitedText(response: Response, limit: number, controller: AbortController): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    controller.abort();
    throw new SearxngSearchError(`SearXNG 回應超過 ${limit} bytes 上限`);
  }
  if (!response.body) throw new SearxngSearchError("SearXNG 回應內容為空");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        controller.abort();
        throw new SearxngSearchError(`SearXNG 回應超過 ${limit} bytes 上限`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}
