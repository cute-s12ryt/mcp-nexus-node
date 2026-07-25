import { afterEach, describe, expect, it, vi } from "vitest";

import { AiBusyError, AiSearchService } from "../src/ai-service.js";
import { defaultAppState } from "../src/app-state.js";
import { McpSessionRegistry } from "../src/mcp-session-registry.js";
import { readRuntimeLimits } from "../src/runtime-limits.js";
import { SearxngSearchService } from "../src/searxng-service.js";
import { InMemoryStateStore } from "../src/state-store.js";

describe("memory guards", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ALLOW_PRIVATE_UPSTREAMS;
  });

  it("loads bounded runtime defaults and rejects unsafe overrides", () => {
    expect(readRuntimeLimits({})).toEqual({
      maxMcpSessions: 8,
      mcpSessionIdleMs: 900_000,
      maxUpstreamTools: 256,
      maxAiResponseBytes: 1_048_576,
      aiRequestTimeoutMs: 120_000,
    });
    expect(readRuntimeLimits({ MCP_MAX_SESSIONS: "2", MCP_MAX_TOOLS: "64" })).toMatchObject({
      maxMcpSessions: 2,
      maxUpstreamTools: 64,
    });
    expect(() => readRuntimeLimits({ MCP_MAX_SESSIONS: "0" })).toThrow("MCP_MAX_SESSIONS");
    expect(() => readRuntimeLimits({ MCP_MAX_AI_RESPONSE_BYTES: "unbounded" })).toThrow("MCP_MAX_AI_RESPONSE_BYTES");
    expect(() => readRuntimeLimits({ MCP_AI_TIMEOUT_MS: "9999" })).toThrow("MCP_AI_TIMEOUT_MS");
  });

  it("caps MCP sessions, isolates scopes, and closes expired resources", async () => {
    let now = 1_000;
    const closed: string[] = [];
    const resource = (name: string) => ({ close: async () => { closed.push(name); } });
    const registry = new McpSessionRegistry(2, 100, () => now);

    registry.register("one", "*", resource("one"));
    registry.register("two", "local", resource("two"));
    expect(registry.get("two", "*")).toBeUndefined();
    expect(registry.get("one", "*")).toBeDefined();
    registry.register("three", "*", resource("three"));
    await vi.waitFor(() => expect(closed).toContain("two"));
    expect(registry.size).toBe(2);

    now += 101;
    expect(registry.get("three", "*")).toBeUndefined();
    await vi.waitFor(() => expect(closed).toEqual(expect.arrayContaining(["one", "three"])));
    expect(registry.size).toBe(0);
  });

  it("closes every tracked MCP resource during shutdown", async () => {
    const closed: string[] = [];
    const registry = new McpSessionRegistry(4, 1_000);
    registry.register("one", "*", { close: async () => { closed.push("one"); } });
    registry.register("two", "local", { close: async () => { closed.push("two"); } });
    await registry.closeAll();
    expect(closed.sort()).toEqual(["one", "two"]);
    expect(registry.size).toBe(0);
  });

  it("closes only MCP sessions belonging to a revoked token scope", async () => {
    const closed: string[] = [];
    const registry = new McpSessionRegistry(4, 1_000);
    registry.register("one", "token-a:*", { close: async () => { closed.push("one"); } });
    registry.register("two", "token-a:local", { close: async () => { closed.push("two"); } });
    registry.register("three", "token-b:*", { close: async () => { closed.push("three"); } });
    await registry.closeScopePrefix("token-a:");
    expect(closed.sort()).toEqual(["one", "two"]);
    expect(registry.size).toBe(1);
    expect(registry.get("three", "token-b:*")).toBeDefined();
  });

  it("rejects oversized AI responses before buffering their body", async () => {
    process.env.ALLOW_PRIVATE_UPSTREAMS = "true";
    const service = configuredAiService(64);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ignored", {
      status: 200,
      headers: { "content-length": "65", "content-type": "application/json" },
    })));

    await expect(service.search("bounded query")).rejects.toThrow("超過 64 bytes 上限");
  });

  it("allows only one in-flight AI search", async () => {
    process.env.ALLOW_PRIVATE_UPSTREAMS = "true";
    const service = configuredAiService(1_024);
    let release: ((response: Response) => void) | undefined;
    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn(() => {
      callCount += 1;
      if (callCount === 1) return new Promise<Response>((resolve) => { release = resolve; });
      return Promise.resolve(Response.json({ model: "test", choices: [{ message: { content: "done" } }] }));
    }));

    const first = service.search("first query");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await expect(service.search("second query")).rejects.toBeInstanceOf(AiBusyError);
    release?.(Response.json({ model: "test", choices: [{ message: { content: "done" } }] }));
    await expect(first).resolves.toMatchObject({ answer: "done" });
  });
});

function configuredAiService(maxResponseBytes: number): AiSearchService {
  const state = defaultAppState();
  state.ai = {
    baseUrl: "http://127.0.0.1:1/v1",
    model: "test-model",
    apiKey: "test-key",
    systemPrompt: "test",
  };
  state.webSearch.endpoint = "http://127.0.0.1:2";
  const webSearch = new SearxngSearchService(maxResponseBytes, () => Promise.resolve(Response.json({ results: [] })));
  return new AiSearchService(new InMemoryStateStore(state), maxResponseBytes, undefined, webSearch);
}
