import { afterEach, describe, expect, it } from "vitest";

import { webSearchSettingsSchema } from "../src/app-state.js";
import { SearxngSearchService } from "../src/searxng-service.js";

describe("SearXNG search adapter", () => {
  afterEach(() => {
    delete process.env.ALLOW_PRIVATE_UPSTREAMS;
  });

  it("maps selected sources to engines, limits concurrency, deduplicates URLs, and keeps partial failures", async () => {
    process.env.ALLOW_PRIVATE_UPSTREAMS = "true";
    let active = 0;
    let peak = 0;
    const requests: URL[] = [];
    const service = new SearxngSearchService(1024 * 1024, async (input) => {
      const url = new URL(String(input));
      requests.push(url);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      if (url.searchParams.get("engines") === "bing") return new Response("unavailable", { status: 503 });
      const engine = url.searchParams.get("engines") ?? "default";
      return Response.json({
        results: [{
          title: `${engine} result`,
          url: engine === "google" ? "https://example.com/page?utm_source=test" : "https://example.com/page",
          content: `${engine} evidence`,
          engine,
        }],
      });
    });
    const settings = webSearchSettingsSchema.parse({
      endpoint: "http://127.0.0.1:8080/search/",
      mode: "parallel",
      sources: ["google", "bing", "duckduckgo", "startpage", "searxng"],
      resultsPerSource: 3,
      language: "zh-TW",
      safeSearch: 1,
    });

    const result = await service.search("agent search", settings);

    expect(peak).toBe(2);
    expect(requests).toHaveLength(5);
    expect(requests.every((url) => url.pathname === "/search" && url.searchParams.get("format") === "json")).toBe(true);
    expect(requests.map((url) => url.searchParams.get("engines"))).toEqual(["google", "bing", "duckduckgo", "startpage", null]);
    expect(result.failures).toEqual([expect.objectContaining({ source: "bing", error: expect.stringContaining("503") })]);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.sources).toEqual(expect.arrayContaining(["google", "duckduckgo", "startpage", "searxng"]));
    expect(result.results[0]?.url).not.toContain("utm_source");
  });

  it("requires one selected source in single mode and reports the JSON configuration hint", async () => {
    expect(() => webSearchSettingsSchema.parse({ mode: "single", sources: ["google", "bing"] })).toThrow("單一模式只能勾選一個");
    process.env.ALLOW_PRIVATE_UPSTREAMS = "true";
    const service = new SearxngSearchService(1024 * 1024, () => Promise.resolve(new Response("Forbidden", { status: 403 })));
    const settings = webSearchSettingsSchema.parse({ endpoint: "http://127.0.0.1:8080", mode: "single", sources: ["searxng"] });

    await expect(service.search("test", settings)).rejects.toThrow("search.formats 已啟用 json");
  });

  it("rejects an oversized response before parsing it", async () => {
    process.env.ALLOW_PRIVATE_UPSTREAMS = "true";
    const service = new SearxngSearchService(64, () => Promise.resolve(new Response("x".repeat(100))));
    const settings = webSearchSettingsSchema.parse({ endpoint: "http://127.0.0.1:8080", sources: ["searxng"] });

    await expect(service.search("test", settings)).rejects.toThrow("超過 64 bytes 上限");
  });
});
