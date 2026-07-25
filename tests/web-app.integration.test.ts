import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express, { type Request, type Response } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { InMemoryStateStore } from "../src/state-store.js";
import { createWebApp } from "../src/web-app.js";

describe.sequential("web control plane and MCP gateway", () => {
  const originalPrivateSetting = process.env.ALLOW_PRIVATE_UPSTREAMS;
  const store = new InMemoryStateStore();
  const loginPath = "/yoyo/s12ryt/login";
  const app = createWebApp(store, { loginPath, host: "127.0.0.1" });
  const upstreamApp = express();
  const upstreamSessions = new Map<string, StreamableHTTPServerTransport>();
  let baseUrl = "";
  let upstreamUrl = "";
  let providerBaseUrl = "";
  let closeApp: () => Promise<void>;
  let closeUpstream: () => Promise<void>;
  let cookie = "";
  let csrfToken = "";
  let gatewayToken = "";
  let secondaryGatewayToken = "";
  let webPath = "";
  let observedAuthorization = "";
  let observedApiKey = "";
  let observedQueryToken = "";
  const providerRequests: Array<Record<string, unknown>> = [];
  const searxngRequests: URL[] = [];

  beforeAll(async () => {
    process.env.ALLOW_PRIVATE_UPSTREAMS = "true";
    upstreamApp.use(express.json());
    upstreamApp.get("/search", (request: Request, response: Response) => {
      const url = new URL(request.originalUrl, "http://fixture.local");
      searxngRequests.push(url);
      const engine = String(request.query.engines ?? "searxng");
      response.json({
        results: [{ title: `${engine} evidence`, url: `https://example.com/${engine}`, content: `${engine} current evidence` }],
      });
    });
    upstreamApp.post("/v1/chat/completions", (request: Request, response: Response) => {
      const body = request.body as Record<string, unknown>;
      providerRequests.push(body);
      const messages = body.messages as Array<Record<string, unknown>>;
      if (body.tool_choice === "none") {
        response.json({ model: body.model, choices: [{ message: { role: "assistant", content: "diagnostic tool result accepted" } }] });
        return;
      }
      const toolNames = Array.isArray(body.tools)
        ? body.tools.map((tool) => (tool as { function?: { name?: string } }).function?.name)
        : [];
      if (body.tool_choice === "auto" && toolNames.includes("searxng_search") && !messages.some(({ role }) => role === "tool")) {
        response.json({
          model: body.model,
          choices: [{ message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: `search-call-${providerRequests.length}`, type: "function", function: { name: "searxng_search", arguments: JSON.stringify({ query: "orchestrate this" }) } }],
          } }],
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
        });
        return;
      }
      if (body.tool_choice && typeof body.tool_choice === "object") {
        response.json({
          model: body.model,
          choices: [{ message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "fixture-call", type: "function", function: { name: "diagnostic_echo", arguments: JSON.stringify({ message: "fixture diagnostic" }) } }],
          } }],
        });
        return;
      }
      response.json({
        model: body.model,
        choices: [{ message: { role: "assistant", content: `agent response ${providerRequests.length}` } }],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      });
    });
    upstreamApp.all("/mcp", async (request: Request, response: Response) => {
      observedAuthorization = request.header("authorization") ?? "";
      observedApiKey = request.header("x-api-key") ?? "";
      observedQueryToken = String(request.query.access_token ?? "");
      const sessionId = request.header("mcp-session-id");
      if (sessionId && upstreamSessions.has(sessionId)) {
        await upstreamSessions.get(sessionId)?.handleRequest(request, response, request.body);
        return;
      }
      if (request.method !== "POST" || !isInitializeRequest(request.body)) {
        response.status(400).json({ error: "initialize first" });
        return;
      }
      const server = new Server({ name: "fixture-upstream", version: "1.0.0" }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, (listRequest) => listRequest.params?.cursor === "second-page"
        ? { tools: [{ name: "status", description: "Status", inputSchema: { type: "object" } }] }
        : {
            tools: [{ name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } } } }],
            nextCursor: "second-page",
          });
      server.setRequestHandler(CallToolRequestSchema, (toolRequest) => ({
        content: [{ type: "text", text: String(toolRequest.params.arguments?.text ?? "") }],
      }));
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (id): void => { upstreamSessions.set(id, transport); },
        onsessionclosed: (id): void => { upstreamSessions.delete(id); },
      });
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    });

    const upstreamListener = upstreamApp.listen(0, "127.0.0.1");
    await listening(upstreamListener);
    upstreamUrl = `http://127.0.0.1:${(upstreamListener.address() as AddressInfo).port}/mcp`;
    providerBaseUrl = `http://127.0.0.1:${(upstreamListener.address() as AddressInfo).port}/v1`;
    closeUpstream = () => close(upstreamListener);

    const listener = app.listen(0, "127.0.0.1");
    await listening(listener);
    baseUrl = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
    closeApp = () => close(listener);
  });

  afterAll(async () => {
    await closeApp();
    await closeUpstream();
    if (originalPrivateSetting === undefined) delete process.env.ALLOW_PRIVATE_UPSTREAMS;
    else process.env.ALLOW_PRIVATE_UPSTREAMS = originalPrivateSetting;
  });

  it("creates the sole administrator and closes registration", async () => {
    expect((await fetch(baseUrl)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/status`)).status).toBe(404);
    expect((await fetch(`${baseUrl}${loginPath}`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/_mcp-nexus/assets/styles.css`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/_mcp-nexus/assets/index.html`)).status).toBe(404);

    const initial = await fetch(`${baseUrl}${loginPath}/api/status`).then((response) => response.json());
    expect(initial).toEqual({ requiresSetup: true });

    const registration = await fetch(`${baseUrl}${loginPath}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "operator", password: "correct-horse-battery" }),
    });
    expect(registration.status).toBe(201);
    const registered = await registration.json() as { csrfToken: string; gatewayToken: string; webPath: string };
    csrfToken = registered.csrfToken;
    gatewayToken = registered.gatewayToken;
    webPath = registered.webPath;
    cookie = registration.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect(cookie).toContain("mcp_nexus_session=");
    expect(webPath).toMatch(/^\/[0-9a-f-]{36}\/web$/);
    const tokens = await fetch(`${baseUrl}${webPath}/api/gateway-tokens`, { headers: { Cookie: cookie } }).then((response) => response.json());
    expect(tokens).toEqual([expect.objectContaining({
      name: "預設 Token",
      tokenSuffix: gatewayToken.slice(-5),
      requestCount: 0,
      successfulToolCalls: 0,
    })]);
    expect(JSON.stringify(tokens)).not.toContain(gatewayToken);

    const unauthenticatedDashboard = await fetch(`${baseUrl}${webPath}`, { redirect: "manual" });
    expect(unauthenticatedDashboard.status).toBe(302);
    expect(unauthenticatedDashboard.headers.get("location")).toBe(loginPath);
    expect((await fetch(`${baseUrl}${webPath}`, { headers: { Cookie: cookie } })).status).toBe(200);

    const duplicate = await fetch(`${baseUrl}${loginPath}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "other-user", password: "another-secure-password" }),
    });
    expect(duplicate.status).toBe(409);
    await expect(fetch(`${baseUrl}${loginPath}/api/status`).then((response) => response.json())).resolves.toEqual({ requiresSetup: false });

    const session = await fetch(`${baseUrl}${loginPath}/api/session`, { headers: { Cookie: cookie } }).then((response) => response.json());
    expect(session).toMatchObject({ authenticated: true, webPath });
  });

  it("enforces loopback Host validation and the JSON body limit", async () => {
    expect(await requestStatus(`${baseUrl}${loginPath}/api/status`, "attacker.example")).toBe(403);

    const oversized = await fetch(`${baseUrl}${loginPath}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "operator", password: "x".repeat(270_000) }),
    });
    expect(oversized.status).toBe(413);
  });

  it("returns the persisted web path after logging in again", async () => {
    const logout = await fetch(`${baseUrl}${webPath}/api/logout`, {
      method: "POST",
      headers: { Cookie: cookie, "X-CSRF-Token": csrfToken },
    });
    expect(logout.status).toBe(204);

    const login = await fetch(`${baseUrl}${loginPath}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "operator", password: "correct-horse-battery" }),
    });
    expect(login.status).toBe(200);
    const loggedIn = await login.json() as { csrfToken: string; webPath: string };
    expect(loggedIn.webPath).toBe(webPath);
    csrfToken = loggedIn.csrfToken;
    cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  });

  it("enforces authentication and CSRF without exposing AI secrets", async () => {
    expect((await fetch(`${baseUrl}${webPath}/api/settings/ai`)).status).toBe(401);
    const unconfiguredSearch = await fetch(`${baseUrl}${webPath}/api/search`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ query: "test query" }),
    });
    expect(unconfiguredSearch.status).toBe(400);
    await expect(unconfiguredSearch.json()).resolves.toEqual({ error: "AI Provider 尚未設定 API Key" });

    const missingCsrf = await fetch(`${baseUrl}${webPath}/api/settings/ai`, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "compatible-model" }),
    });
    expect(missingCsrf.status).toBe(403);

    const updated = await apiFetch("/api/settings/ai", {
      method: "PUT",
      body: { baseUrl: providerBaseUrl, model: "compatible-model", apiKey: "secret-ai-key" },
    });
    expect(updated).toMatchObject({ model: "compatible-model", hasApiKey: true });
    expect(JSON.stringify(updated)).not.toContain("secret-ai-key");
  });

  it("persists Agent orchestration, runs diagnostics, and gives tools only to research agents", async () => {
    const defaults = await apiFetch("/api/settings/search-orchestration", { method: "GET" }) as Record<string, unknown>;
    expect(defaults).toMatchObject({ mode: "precision", customConcurrency: 3, historyCharLimit: 12_000 });

    const orchestration = await apiFetch("/api/settings/search-orchestration", {
      method: "PUT",
      body: {
        mode: "custom",
        customConcurrency: 2,
        historyCharLimit: 2_000,
        maxOutputTokens: 256,
        samplingMode: "top_p",
        topP: 0.7,
      },
    });
    expect(orchestration).toMatchObject({ mode: "custom", customConcurrency: 2, maxOutputTokens: 256, samplingMode: "top_p", topP: 0.7 });

    const searchDefaults = await apiFetch("/api/settings/web-search", { method: "GET" });
    expect(searchDefaults).toMatchObject({ endpoint: "", mode: "single", sources: ["searxng"] });
    const configuredControl = await apiFetch("/api/settings/search-control", {
      method: "PUT",
      body: {
        orchestration: {},
        webSearch: {
          endpoint: providerBaseUrl.replace(/\/v1$/, ""),
          mode: "parallel",
          sources: ["google", "searxng"],
          resultsPerSource: 3,
          language: "zh-TW",
          safeSearch: 1,
        },
      },
    });
    expect(configuredControl).toMatchObject({ webSearch: { mode: "parallel", sources: ["google", "searxng"] } });
    await expect(apiFetch("/api/settings/web-search/test", { method: "POST", body: {} })).resolves.toMatchObject({
      results: expect.arrayContaining([expect.objectContaining({ sources: expect.any(Array) })]),
    });

    let requestStart = providerRequests.length;
    const diagnostic = await apiFetch("/api/settings/ai/test", {
      method: "POST",
      body: { baseUrl: providerBaseUrl, model: "diagnostic-model", apiKey: "" },
    }) as { success: boolean; toolCalling: { toolResult: unknown; finalAnswer: string } };
    expect(diagnostic).toMatchObject({
      success: true,
      toolCalling: { toolResult: { echoed: "fixture diagnostic", diagnostic: true }, finalAnswer: "diagnostic tool result accepted" },
    });
    const diagnosticRequests = providerRequests.slice(requestStart);
    expect(diagnosticRequests).toHaveLength(3);
    expect(diagnosticRequests[1]).toHaveProperty("tools");
    expect(diagnosticRequests[2]?.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "tool", tool_call_id: "fixture-call" })]));

    requestStart = providerRequests.length;
    const search = await apiFetch("/api/search", { method: "POST", body: { query: "orchestrate this" } }) as {
      mode: string;
      answer: string;
      stages: unknown[];
      usage: { totalTokens: number };
      webSearch: { results: unknown[]; failures: unknown[] };
    };
    expect(search).toMatchObject({ mode: "custom", stages: expect.any(Array), usage: { totalTokens: 25 }, webSearch: { failures: [] } });
    expect(search.stages).toHaveLength(3);
    expect(search.webSearch.results).toHaveLength(2);
    expect(search.answer).toMatch(/^agent response /);
    const searchRequests = providerRequests.slice(requestStart);
    expect(searchRequests).toHaveLength(5);
    const researchRequests = searchRequests.filter((body) => Array.isArray(body.tools));
    expect(researchRequests).toHaveLength(4);
    expect(researchRequests.every((body) => body.tool_choice === "auto")).toBe(true);
    expect(searchRequests.filter((body) => !Array.isArray(body.tools))).toHaveLength(1);
    expect(searchRequests.filter((body) => !Array.isArray(body.tools)).every((body) => !("tool_choice" in body))).toBe(true);
    expect(searchRequests.every((body) => body.top_p === 0.7 && !("temperature" in body))).toBe(true);
    expect(searxngRequests).toEqual(expect.arrayContaining([
      expect.objectContaining({ search: expect.stringContaining("engines=google") }),
      expect.objectContaining({ search: expect.not.stringContaining("engines=") }),
    ]));
  });

  it("aggregates tools and preserves names on a single-upstream export", async () => {
    const upstream = await apiFetch("/api/upstreams", {
      method: "POST",
      body: {
        name: "Local fixture",
        alias: "local",
        endpoint: upstreamUrl,
        bearerToken: "legacy-upstream-secret",
        authParameters: [
          { location: "header", name: "Authorization", value: "Custom custom-auth-secret" },
          { location: "header", name: "X-API-Key", value: "header-api-secret" },
          { location: "query", name: "access_token", value: "query-api-secret" },
        ],
        enabled: true,
      },
    });
    expect(upstream).toMatchObject({
      alias: "local",
      hasAuthentication: true,
      hasBearerToken: true,
      exportPath: "/mcp/local",
      authParameterSummaries: [
        { location: "header", name: "Authorization" },
        { location: "header", name: "X-API-Key" },
        { location: "query", name: "access_token" },
      ],
    });
    const publicJson = JSON.stringify(upstream);
    for (const secret of ["legacy-upstream-secret", "custom-auth-secret", "header-api-secret", "query-api-secret"]) {
      expect(publicJson).not.toContain(secret);
    }
    await expect(apiFetch("/api/upstreams/local/test", { method: "POST" })).resolves.toMatchObject({ toolCount: 2 });
    expect(observedAuthorization).toBe("Custom custom-auth-secret");
    expect(observedApiKey).toBe("header-api-secret");
    expect(observedQueryToken).toBe("query-api-secret");

    const aggregated = await connectGateway("/mcp");
    const aggregatedTools = await aggregated.listTools();
    expect(aggregatedTools.tools.map(({ name }) => name)).toContain("local.echo");
    expect(aggregatedTools.tools.map(({ name }) => name)).toContain("local.status");
    const called = await aggregated.callTool({ name: "local.echo", arguments: { text: "gateway works" } });
    expect(called.content).toContainEqual(expect.objectContaining({ type: "text", text: "gateway works" }));
    await aggregated.close();

    const single = await connectGateway("/mcp/local");
    const singleTools = await single.listTools();
    expect(singleTools.tools.map(({ name }) => name)).toContain("echo");
    await single.close();
  });

  it("rejects MCP requests without the gateway token", async () => {
    const response = await fetch(`${baseUrl}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(response.status).toBe(401);
  });

  it("manages multiple tokens and persists per-token requests, successful calls, and bounded log details", async () => {
    const created = await apiFetch("/api/gateway-tokens", {
      method: "POST",
      body: { name: "Integration Client" },
    }) as { gatewayToken: string; token: { id: string; tokenSuffix: string } };
    secondaryGatewayToken = created.gatewayToken;
    expect(created.token.tokenSuffix).toBe(secondaryGatewayToken.slice(-5));

    const client = await connectGateway("/mcp", secondaryGatewayToken);
    await client.listTools();
    await client.callTool({ name: "local.echo", arguments: { text: "count this call" } });
    await client.close();

    const tokens = await apiFetch("/api/gateway-tokens", { method: "GET" }) as Array<{
      id: string;
      requestCount: number;
      successfulToolCalls: number;
    }>;
    expect(tokens).toHaveLength(2);
    expect(tokens.find(({ id }) => id === created.token.id)).toMatchObject({
      requestCount: expect.any(Number),
      successfulToolCalls: 1,
    });
    expect(tokens.find(({ id }) => id === created.token.id)?.requestCount).toBeGreaterThanOrEqual(3);

    const logs = await apiFetch("/api/request-logs", { method: "GET" }) as Array<{
      tokenId: string;
      method: string;
      endpoint: string;
    }>;
    expect(logs).toEqual(expect.arrayContaining([
      expect.objectContaining({ tokenId: created.token.id, method: "tools/list", endpoint: "/mcp" }),
      expect.objectContaining({ tokenId: created.token.id, method: "tools/call", endpoint: "/mcp" }),
    ]));
    expect(JSON.stringify(logs)).not.toContain(secondaryGatewayToken);
    expect(JSON.stringify(logs)).not.toContain("count this call");

    const revoked = await fetch(`${baseUrl}${webPath}/api/gateway-tokens/${created.token.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie, "X-CSRF-Token": csrfToken },
    });
    expect(revoked.status).toBe(204);
    const rejected = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secondaryGatewayToken}`, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(rejected.status).toBe(401);
  });

  it("rotates the persisted web path and invalidates the previous UUID", async () => {
    const previousPath = webPath;
    const rotated = await apiFetch("/api/web-path/rotate", { method: "POST" }) as { webPath: string };
    webPath = rotated.webPath;
    expect(webPath).toMatch(/^\/[0-9a-f-]{36}\/web$/);
    expect(webPath).not.toBe(previousPath);
    expect((await fetch(`${baseUrl}${previousPath}`, { headers: { Cookie: cookie } })).status).toBe(404);
    expect((await fetch(`${baseUrl}${webPath}`, { headers: { Cookie: cookie } })).status).toBe(200);
    expect((await store.read()).webPathUuid).toBe(webPath.split("/")[1]);
  });

  async function apiFetch(path: string, options: { method: string; body?: unknown }): Promise<unknown> {
    const response = await fetch(`${baseUrl}${webPath}${path}`, {
      method: options.method,
      headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    expect(response.ok).toBe(true);
    if (response.status === 204) return undefined;
    return response.json();
  }

  async function connectGateway(path: string, token = gatewayToken): Promise<Client> {
    const client = new Client({ name: "gateway-test", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}${path}`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    return client;
  }
});

function requestStatus(url: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers: { Host: host } }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("error", reject);
    request.end();
  });
}

function listening(server: ReturnType<typeof express.application.listen>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
}

function close(server: ReturnType<typeof express.application.listen>): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
