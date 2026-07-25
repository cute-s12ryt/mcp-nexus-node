import { afterEach, describe, expect, it } from "vitest";

import { AiSearchService } from "../src/ai-service.js";
import { aiSettingsPatchSchema, defaultAppState, searchOrchestrationPatchSchema, type AppState } from "../src/app-state.js";
import { SearxngSearchService } from "../src/searxng-service.js";
import { InMemoryStateStore } from "../src/state-store.js";

describe("AI Agent orchestration", () => {
  afterEach(() => {
    delete process.env.ALLOW_PRIVATE_UPSTREAMS;
  });

  it("keeps omitted fields absent in partial orchestration updates", () => {
    expect(searchOrchestrationPatchSchema.parse({ mode: "custom" })).toEqual({ mode: "custom" });
    expect(aiSettingsPatchSchema.parse({ model: "new-model" })).toEqual({ model: "new-model" });
  });

  it("redacts the API key from diagnostic provider errors", async () => {
    process.env.ALLOW_PRIVATE_UPSTREAMS = "true";
    const service = createService(() => Promise.resolve(new Response("authorization failed for fixture-key", { status: 401 })));

    const result = await service.testProvider();

    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toContain("fixture-key");
    expect(result.basic.rawError).toContain("[redacted]");
    expect(result.toolCalling.rawError).toContain("[redacted]");
  });

  it.each([
    ["precision", 3, 4, ["規劃 Agent", "搜尋／分析 Agent", "審核 Agent", "彙整 Agent"]],
    ["parallel", 3, 6, ["搜尋／分析 Agent 1", "搜尋／分析 Agent 5", "統整 Agent"]],
    ["custom", 3, 4, ["搜尋／分析 Agent 1", "搜尋／分析 Agent 3", "統整 Agent"]],
  ] as const)("runs %s mode and exposes tools only to research agents", async (mode, concurrency, expectedCalls, labels) => {
    process.env.ALLOW_PRIVATE_UPSTREAMS = "true";
    const bodies: Array<Record<string, unknown>> = [];
    const service = createService((_, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Promise.resolve(completion(`response-${bodies.length}`, { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }));
    }, (state) => {
      state.searchOrchestration.mode = mode;
      state.searchOrchestration.customConcurrency = concurrency;
    });

    const result = await service.search("How should this be analyzed?");

    expect(bodies).toHaveLength(expectedCalls);
    const researchRequests = bodies.filter((body) => Array.isArray(body.tools));
    expect(researchRequests).toHaveLength(mode === "precision" ? 1 : mode === "parallel" ? 5 : concurrency);
    expect(researchRequests.every((body) => body.tool_choice === "auto")).toBe(true);
    expect(researchRequests.every((body) => JSON.stringify(body.tools).includes("curl") && JSON.stringify(body.tools).includes("searxng_search"))).toBe(true);
    expect(bodies.filter((body) => !Array.isArray(body.tools)).every((body) => !("tool_choice" in body))).toBe(true);
    expect(result.mode).toBe(mode);
    expect(result.stages.map(({ label }) => label)).toEqual(expect.arrayContaining(labels));
    expect(result.answer).toBe(`response-${expectedCalls}`);
    expect(result.usage).toEqual({ promptTokens: expectedCalls * 2, completionTokens: expectedCalls * 3, totalTokens: expectedCalls * 5 });
    expect(result.webSearch.results).toEqual([]);
    expect(JSON.stringify(researchRequests)).toContain("untrusted data");
  });

  it("executes multiple research tools and returns their results in a second model round", async () => {
    process.env.ALLOW_PRIVATE_UPSTREAMS = "true";
    const bodies: Array<Record<string, unknown>> = [];
    const service = createService((input, init) => {
      const url = String(input);
      if (url === "http://127.0.0.1:9876/direct") {
        return Promise.resolve(new Response("direct evidence", { headers: { "Content-Type": "text/plain" } }));
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      const messages = body.messages as Array<Record<string, unknown>>;
      if (Array.isArray(body.tools) && !messages.some(({ role }) => role === "tool")) {
        return Promise.resolve(Response.json({
          model: "fixture-model",
          choices: [{ message: {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "search-call", type: "function", function: { name: "searxng_search", arguments: JSON.stringify({ query: "current topic" }) } },
              { id: "curl-call", type: "function", function: { name: "curl", arguments: JSON.stringify({ url: "http://127.0.0.1:9876/direct" }) } },
            ],
          } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
      }
      return Promise.resolve(completion(`stage-${bodies.length}`, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }));
    });

    const result = await service.search("Research current topic");

    const followUp = bodies.find((body) => {
      const messages = body.messages as Array<Record<string, unknown>>;
      return messages.some(({ role }) => role === "tool");
    });
    expect(followUp?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "tool", tool_call_id: "search-call" }),
      expect.objectContaining({ role: "tool", tool_call_id: "curl-call" }),
    ]));
    expect(result.webSearch.results[0]).toMatchObject({ title: "Fixture evidence", url: "https://example.com/evidence" });
    expect(result.stages).toHaveLength(4);
    expect(result.answer).toMatch(/^stage-/);
  });

  it("tests basic completion, built-in tool calling, and the returned tool result", async () => {
    process.env.ALLOW_PRIVATE_UPSTREAMS = "true";
    const bodies: Array<Record<string, unknown>> = [];
    const service = createService((_, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (bodies.length === 1) return Promise.resolve(completion("basic diagnostic passed"));
      if (bodies.length === 2) {
        return Promise.resolve(Response.json({
          model: "fixture-model",
          choices: [{ message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call-1", type: "function", function: { name: "diagnostic_echo", arguments: JSON.stringify({ message: "MCP Nexus tool calling works" }) } }],
          } }],
        }));
      }
      return Promise.resolve(completion("tool result accepted"));
    });

    const result = await service.testProvider();

    expect(result).toMatchObject({
      success: true,
      basic: { success: true, response: "basic diagnostic passed" },
      toolCalling: {
        success: true,
        toolCalls: [{ id: "call-1", name: "diagnostic_echo" }],
        toolResult: { echoed: "MCP Nexus tool calling works", diagnostic: true },
        finalAnswer: "tool result accepted",
      },
    });
    expect(bodies).toHaveLength(3);
    expect(bodies.every((body) => body.max_tokens === 256)).toBe(true);
    expect(bodies[0]).not.toHaveProperty("tools");
    expect(bodies[1]).toMatchObject({
      tool_choice: { type: "function", function: { name: "diagnostic_echo" } },
      tools: [{ function: { name: "diagnostic_echo" } }],
    });
    expect(bodies[2]).toMatchObject({ tool_choice: "none" });
    expect(bodies[2]?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "tool", tool_call_id: "call-1" }),
    ]));
  });

  it("reports provider timeouts separately from response-size failures", async () => {
    process.env.ALLOW_PRIVATE_UPSTREAMS = "true";
    const service = createService((_, init) => new Promise<Response>((_, reject) => {
      const signal = init?.signal;
      if (!signal) return reject(new Error("missing abort signal"));
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }), undefined, 5);

    const result = await service.testProvider();

    expect(result.basic.rawError).toBe("AI Provider 請求超過 5 ms，已中止");
    expect(result.toolCalling.rawError).toBe("AI Provider 請求超過 5 ms，已中止");
    expect(JSON.stringify(result)).not.toContain("回應超過大小上限");
  });

  it("keeps tool-call content visible when diagnostic arguments are invalid", async () => {
    process.env.ALLOW_PRIVATE_UPSTREAMS = "true";
    let call = 0;
    const service = createService(() => {
      call += 1;
      if (call === 1) return Promise.resolve(completion("basic ok"));
      return Promise.resolve(Response.json({
        model: "fixture-model",
        choices: [{ message: {
          content: null,
          tool_calls: [{ id: "bad-call", type: "function", function: { name: "diagnostic_echo", arguments: "not-json" } }],
        } }],
      }));
    });

    const result = await service.testProvider();

    expect(result.success).toBe(false);
    expect(result.toolCalling.toolCalls).toEqual([{ id: "bad-call", name: "diagnostic_echo", arguments: "not-json" }]);
    expect(result.toolCalling.rawError).toContain("SyntaxError");
  });
});

function createService(
  fetcher: typeof fetch,
  configure?: (state: AppState) => void,
  requestTimeoutMs = 120_000,
): AiSearchService {
  const state = defaultAppState();
  state.ai = {
    baseUrl: "http://127.0.0.1:1/v1",
    model: "fixture-model",
    apiKey: "fixture-key",
    systemPrompt: "System prompt",
  };
  state.webSearch.endpoint = "http://127.0.0.1:2";
  configure?.(state);
  const webSearch = new SearxngSearchService(1024 * 1024, () => Promise.resolve(Response.json({
    results: [{ title: "Fixture evidence", url: "https://example.com/evidence", content: "Current evidence." }],
  })));
  return new AiSearchService(new InMemoryStateStore(state), 1024 * 1024, fetcher, webSearch, requestTimeoutMs);
}

function completion(content: string, usage?: Record<string, number>): Response {
  return Response.json({ model: "fixture-model", choices: [{ message: { role: "assistant", content } }], usage });
}
