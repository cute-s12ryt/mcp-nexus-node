import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { AgentToolSession, agentCurlInputSchema } from "../src/agent-tools.js";
import { defaultAppState } from "../src/app-state.js";
import { SearxngSearchService } from "../src/searxng-service.js";

describe("Agent HTTP tools", () => {
  afterEach(() => {
    delete process.env.ALLOW_PRIVATE_UPSTREAMS;
  });

  it("rejects transport headers, control characters, and GET bodies", () => {
    expect(() => agentCurlInputSchema.parse({ url: "https://example.com", headers: { Host: "internal" } })).toThrow(/不允許/);
    expect(() => agentCurlInputSchema.parse({ url: "https://example.com", headers: { "X-Test": "bad\r\nvalue" } })).toThrow(/控制字元/);
    expect(() => agentCurlInputSchema.parse({ url: "https://example.com", headers: { "X-Test": "one", "x-test": "two" } })).toThrow(/大小寫重複/);
    expect(() => agentCurlInputSchema.parse({ url: "https://example.com", method: "GET", body: "not allowed" })).toThrow(/不可包含 body/);
    expect(agentCurlInputSchema.parse({
      url: "https://example.com/api",
      method: "POST",
      headers: { Authorization: "Bearer model-provided", "Content-Type": "application/json" },
      body: "{}",
    })).toMatchObject({ method: "POST" });
  });

  it("uses the pinned native HTTP path in production mode", async () => {
    process.env.ALLOW_PRIVATE_UPSTREAMS = "true";
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ method: request.method, header: request.headers["x-test"], body: Buffer.concat(chunks).toString("utf8") }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const port = (server.address() as AddressInfo).port;
      const session = createSession();
      const result = await session.execute({
        name: "curl",
        arguments: JSON.stringify({
          url: `http://127.0.0.1:${port}/echo`,
          method: "POST",
          headers: { "Content-Type": "text/plain", "X-Test": "pinned" },
          body: "native request",
        }),
      });
      const parsed = JSON.parse(result.content) as { status: number; body: string };
      expect(result.isError).toBe(false);
      expect(parsed.status).toBe(200);
      expect(JSON.parse(parsed.body)).toEqual({ method: "POST", header: "pinned", body: "native request" });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("limits HTTP concurrency, response size, and the total tool-call budget", async () => {
    process.env.ALLOW_PRIVATE_UPSTREAMS = "true";
    let active = 0;
    let peak = 0;
    const fetcher: typeof fetch = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return new Response("x".repeat(300_000), { headers: { "Content-Type": "text/plain" } });
    };
    const session = createSession(fetcher);
    const calls = await Promise.all(Array.from({ length: 3 }, (_, index) => session.execute({
      name: "curl",
      arguments: JSON.stringify({ url: `http://127.0.0.1:${9_000 + index}/data` }),
    })));

    expect(peak).toBe(1);
    expect(calls.every(({ isError }) => !isError)).toBe(true);
    expect(calls.every(({ content }) => JSON.parse(content).truncated === true)).toBe(true);

    for (let index = 0; index < 9; index += 1) {
      await session.execute({ name: "unknown", arguments: "{}" });
    }
    const overBudget = await session.execute({ name: "curl", arguments: JSON.stringify({ url: "http://127.0.0.1:9999" }) });
    expect(overBudget).toMatchObject({ isError: true });
    expect(overBudget.content).toContain("總上限 12 次");
  });

  it("uses only the configured SearXNG endpoint and accumulates bounded evidence", async () => {
    process.env.ALLOW_PRIVATE_UPSTREAMS = "true";
    const requested: URL[] = [];
    const webSearch = new SearxngSearchService(1024 * 1024, (input) => {
      requested.push(new URL(String(input)));
      return Promise.resolve(Response.json({
        results: [{ title: "Tool evidence", url: "https://example.com/item?utm_source=test", content: "Current evidence" }],
      }));
    });
    const settings = defaultAppState().webSearch;
    settings.endpoint = "http://127.0.0.1:8080";
    settings.mode = "parallel";
    settings.sources = ["google", "searxng"];
    const session = new AgentToolSession(settings, webSearch, fetch);

    const result = await session.execute({
      name: "searxng_search",
      arguments: JSON.stringify({ query: "tool query" }),
    });

    expect(result.isError).toBe(false);
    expect(requested).toHaveLength(2);
    expect(requested[0]?.origin).toBe("http://127.0.0.1:8080");
    expect(requested).toEqual(expect.arrayContaining([
      expect.objectContaining({ search: expect.stringContaining("engines=google") }),
      expect.objectContaining({ search: expect.not.stringContaining("engines=") }),
    ]));
    expect(session.evidence().results).toEqual([
      expect.objectContaining({ title: "Tool evidence", url: "https://example.com/item", sources: ["google", "searxng"] }),
    ]);
  });
});

function createSession(fetcher?: typeof fetch): AgentToolSession {
  const settings = defaultAppState().webSearch;
  settings.endpoint = "http://127.0.0.1:8080";
  const webSearch = new SearxngSearchService(1024 * 1024, () => Promise.resolve(Response.json({ results: [] })));
  return new AgentToolSession(settings, webSearch, fetcher);
}
