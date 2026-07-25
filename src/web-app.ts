import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { NextFunction, Request, Response } from "express";
import express from "express";
import { z } from "zod";

import { AiBusyError, AiConfigurationError, AiProviderError, AiSearchService } from "./ai-service.js";
import {
  aiSettingsPatchSchema,
  gatewayTokenNameSchema,
  searchOrchestrationPatchSchema,
  searchOrchestrationSchema,
  upstreamAliasSchema,
  upstreamAuthParametersSchema,
  upstreamSchema,
  webSearchSettingsPatchSchema,
  webSearchSettingsSchema,
} from "./app-state.js";
import { GatewayTokenError, GatewayTokenService, type GatewayTokenIdentity } from "./gateway-token-service.js";
import { McpSessionRegistry } from "./mcp-session-registry.js";
import { assertSafeRemoteUrl } from "./network-policy.js";
import { readRuntimeLimits } from "./runtime-limits.js";
import { SearxngSearchError, SearxngSearchService, WebSearchConfigurationError } from "./searxng-service.js";
import {
  digestSecret,
  digestToken,
  generateToken,
  LoginGuard,
  parseCookie,
  SessionManager,
  verifySecret,
  type AuthSession,
} from "./security.js";
import { normalizeLoginPath } from "./startup-config.js";
import type { StateStore } from "./state-store.js";
import type { UpstreamService } from "./upstream-service.js";

export { normalizeLoginPath } from "./startup-config.js";

const credentialsSchema = z.object({
  username: z.string().trim().min(3).max(64),
  password: z.string().min(10).max(200),
});
const searchSchema = z.object({ query: z.string().trim().min(1).max(4_000) });
const gatewayTokenInputSchema = z.object({ name: gatewayTokenNameSchema });
const searchControlInputSchema = z.object({
  orchestration: searchOrchestrationPatchSchema,
  webSearch: webSearchSettingsPatchSchema,
});
const upstreamInputSchema = upstreamSchema.omit({ id: true, createdAt: true, authParameters: true }).extend({
  bearerToken: z.string().max(8_000).optional().default(""),
  authParameters: upstreamAuthParametersSchema.optional().default([]),
});

interface AuthenticatedRequest extends Request {
  authSession: AuthSession;
  sessionToken: string;
}

export interface WebAppOptions {
  loginPath?: string;
  host?: string;
}

export interface WebRuntime {
  app: ReturnType<typeof express>;
  close(): Promise<void>;
}

const WEB_ROUTE = "/:webPathUuid/web";
const ASSET_PATH = "/_mcp-nexus/assets";

export function createWebApp(store: StateStore, options: WebAppOptions = {}) {
  return createWebRuntime(store, options).app;
}

export function createWebRuntime(store: StateStore, options: WebAppOptions = {}): WebRuntime {
  const host = options.host ?? process.env.HOST ?? "127.0.0.1";
  const loginPath = normalizeLoginPath(options.loginPath ?? process.env.WEB_LOGIN_PATH ?? "/login");
  const limits = readRuntimeLimits();
  const dashboardApi = (path: string) => `${WEB_ROUTE}/api${path}`;
  const app = express();
  const sessions = new SessionManager();
  const loginGuard = new LoginGuard();
  const mcpSessions = new McpSessionRegistry<StreamableHTTPServerTransport>(limits.maxMcpSessions, limits.mcpSessionIdleMs);
  const searxngSearch = new SearxngSearchService(limits.maxAiResponseBytes);
const aiSearch = new AiSearchService(store, limits.maxAiResponseBytes, undefined, searxngSearch, limits.aiRequestTimeoutMs);
  const gatewayTokens = new GatewayTokenService(store);
  let upstreamsPromise: Promise<UpstreamService> | undefined;
  const getUpstreams = () => upstreamsPromise ??= import("./upstream-service.js")
    .then(({ UpstreamService }) => new UpstreamService(store, limits.maxUpstreamTools));
  const requireControlAuth = requireAuth(sessions, loginPath);

  app.disable("x-powered-by");
  installHostValidation(app, host);
  app.use(express.json({ limit: "256kb" }));
  app.use((_request, response, next) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    next();
  });

  app.use(WEB_ROUTE, requireCurrentWebPath(store));

  app.get([`${loginPath}/api/status`, dashboardApi("/status")], async (_request, response) => {
    const state = await store.read();
    response.json({ requiresSetup: !state.administrator });
  });

  app.get([`${loginPath}/api/session`, dashboardApi("/session")], async (request, response, next) => {
    try {
      const token = parseCookie(request.headers.cookie, "mcp_nexus_session");
      const session = sessions.get(token);
      const webPath = await currentWebPath(store);
      response.json(session
        ? { authenticated: true, username: session.username, csrfToken: session.csrfToken, webPath }
        : { authenticated: false });
    } catch (error) {
      next(error);
    }
  });

  app.post(`${loginPath}/api/register`, async (request, response, next) => {
    try {
      if ((await store.read()).administrator) throw new HttpError(409, "管理員已建立，註冊入口已關閉");
      const input = credentialsSchema.parse(request.body);
      const password = await digestSecret(input.password);
      const gatewayToken = generateToken();
      await store.update((state) => {
        if (state.administrator) throw new HttpError(409, "管理員已建立，註冊入口已關閉");
        state.administrator = { username: input.username, passwordSalt: password.salt, passwordHash: password.hash };
        state.webPathUuid ??= randomUUID();
        state.gatewayTokens = [{
          id: randomUUID(),
          name: "預設 Token",
          tokenSalt: "sha256",
          tokenHash: digestToken(gatewayToken),
          tokenSuffix: gatewayToken.slice(-5),
          requestCount: 0,
          successfulToolCalls: 0,
          createdAt: new Date().toISOString(),
        }];
        state.gatewayTokenSalt = undefined;
        state.gatewayTokenHash = undefined;
      });
      const created = sessions.create(input.username);
      setSessionCookie(response, created.token);
      response.status(201).json({
        username: input.username,
        csrfToken: created.session.csrfToken,
        gatewayToken,
        webPath: await currentWebPath(store),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post(`${loginPath}/api/login`, async (request, response, next) => {
    try {
      const loginKey = request.ip ?? request.socket.remoteAddress ?? "unknown";
      if (!loginGuard.isAllowed(loginKey)) throw new HttpError(429, "登入嘗試過於頻繁，請稍後再試");
      const input = credentialsSchema.parse(request.body);
      const { administrator } = await store.read();
      const passwordValid = administrator
        ? await verifySecret(input.password, { salt: administrator.passwordSalt, hash: administrator.passwordHash })
        : false;
      const valid = passwordValid && administrator?.username === input.username;
      if (!valid) {
        loginGuard.recordFailure(loginKey);
        throw new HttpError(401, "帳號或密碼錯誤");
      }
      loginGuard.clear(loginKey);
      const created = sessions.create(input.username);
      setSessionCookie(response, created.token);
      response.json({ username: input.username, csrfToken: created.session.csrfToken, webPath: await currentWebPath(store) });
    } catch (error) {
      next(error);
    }
  });

  app.post(dashboardApi("/logout"), requireControlAuth, requireCsrf, (request, response) => {
    const authenticated = request as AuthenticatedRequest;
    sessions.delete(authenticated.sessionToken);
    response.setHeader("Set-Cookie", "mcp_nexus_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
    response.status(204).end();
  });

  app.get(dashboardApi("/me"), requireControlAuth, (request, response) => {
    const session = (request as AuthenticatedRequest).authSession;
    response.json({ username: session.username, csrfToken: session.csrfToken });
  });

  app.get(dashboardApi("/settings/ai"), requireControlAuth, async (_request, response) => {
    const { ai } = await store.read();
    response.json({ baseUrl: ai.baseUrl, model: ai.model, systemPrompt: ai.systemPrompt, hasApiKey: Boolean(ai.apiKey) });
  });

  app.put(dashboardApi("/settings/ai"), requireControlAuth, requireCsrf, async (request, response, next) => {
    try {
      const input = aiSettingsPatchSchema.parse(request.body);
      if (input.baseUrl) await assertSafeRemoteUrl(input.baseUrl);
      const state = await store.update((draft) => {
        draft.ai = { ...draft.ai, ...input, apiKey: input.apiKey || draft.ai.apiKey };
      });
      response.json({ baseUrl: state.ai.baseUrl, model: state.ai.model, systemPrompt: state.ai.systemPrompt, hasApiKey: Boolean(state.ai.apiKey) });
    } catch (error) {
      next(error);
    }
  });

  app.post(dashboardApi("/settings/ai/test"), requireControlAuth, requireCsrf, async (request, response, next) => {
    try {
      const input = aiSettingsPatchSchema.parse(request.body);
      response.json(await aiSearch.testProvider(input));
    } catch (error) {
      next(error);
    }
  });

  app.get(dashboardApi("/settings/search-orchestration"), requireControlAuth, async (_request, response) => {
    const { searchOrchestration } = await store.read();
    response.json(searchOrchestration);
  });

  app.put(dashboardApi("/settings/search-orchestration"), requireControlAuth, requireCsrf, async (request, response, next) => {
    try {
      const input = searchOrchestrationPatchSchema.parse(request.body);
      const state = await store.update((draft) => {
        draft.searchOrchestration = searchOrchestrationSchema.parse({ ...draft.searchOrchestration, ...input });
      });
      response.json(state.searchOrchestration);
    } catch (error) {
      next(error);
    }
  });

  app.get(dashboardApi("/settings/web-search"), requireControlAuth, async (_request, response) => {
    const { webSearch } = await store.read();
    response.json(webSearch);
  });

  app.put(dashboardApi("/settings/web-search"), requireControlAuth, requireCsrf, async (request, response, next) => {
    try {
      const input = webSearchSettingsPatchSchema.parse(request.body);
      if (input.endpoint) await assertSafeRemoteUrl(input.endpoint);
      const state = await store.update((draft) => {
        draft.webSearch = webSearchSettingsSchema.parse({ ...draft.webSearch, ...input });
      });
      response.json(state.webSearch);
    } catch (error) {
      next(error);
    }
  });

  app.put(dashboardApi("/settings/search-control"), requireControlAuth, requireCsrf, async (request, response, next) => {
    try {
      const input = searchControlInputSchema.parse(request.body);
      if (input.webSearch.endpoint) await assertSafeRemoteUrl(input.webSearch.endpoint);
      const state = await store.update((draft) => {
        draft.searchOrchestration = searchOrchestrationSchema.parse({ ...draft.searchOrchestration, ...input.orchestration });
        draft.webSearch = webSearchSettingsSchema.parse({ ...draft.webSearch, ...input.webSearch });
      });
      response.json({ orchestration: state.searchOrchestration, webSearch: state.webSearch });
    } catch (error) {
      next(error);
    }
  });

  app.post(dashboardApi("/settings/web-search/test"), requireControlAuth, requireCsrf, async (request, response, next) => {
    try {
      const input = webSearchSettingsPatchSchema.parse(request.body);
      const current = (await store.read()).webSearch;
      const settings = webSearchSettingsSchema.parse({ ...current, ...input });
      response.json(await searxngSearch.search("SearXNG connectivity test", settings));
    } catch (error) {
      next(error);
    }
  });

  app.post(dashboardApi("/search"), requireControlAuth, requireCsrf, async (request, response, next) => {
    try {
      const { query } = searchSchema.parse(request.body);
      response.json(await aiSearch.search(query));
    } catch (error) {
      next(error);
    }
  });

  app.get(dashboardApi("/upstreams"), requireControlAuth, async (_request, response) => {
    const { upstreams: configs } = await store.read();
    response.json(configs.map(toPublicUpstream));
  });

  app.post(dashboardApi("/upstreams"), requireControlAuth, requireCsrf, async (request, response, next) => {
    try {
      const input = upstreamInputSchema.parse(request.body);
      await assertSafeRemoteUrl(input.endpoint);
      const config = upstreamSchema.parse({ ...input, id: randomUUID(), createdAt: new Date().toISOString() });
      await store.update((state) => {
        if (state.upstreams.some(({ alias }) => alias === config.alias)) throw new HttpError(409, "Alias 已存在");
        state.upstreams.push(config);
      });
      response.status(201).json(toPublicUpstream(config));
    } catch (error) {
      next(error);
    }
  });

  app.delete(dashboardApi("/upstreams/:id"), requireControlAuth, requireCsrf, async (request, response, next) => {
    try {
      await store.update((state) => {
        const index = state.upstreams.findIndex(({ id }) => id === request.params.id);
        if (index < 0) throw new HttpError(404, "找不到上游 MCP");
        state.upstreams.splice(index, 1);
      });
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.post(dashboardApi("/upstreams/:alias/test"), requireControlAuth, requireCsrf, async (request, response, next) => {
    try {
      response.json(await (await getUpstreams()).test(routeParameter(request.params.alias, "alias")));
    } catch (error) {
      next(error);
    }
  });

  app.get(dashboardApi("/gateway-tokens"), requireControlAuth, async (_request, response, next) => {
    try {
      response.json(await gatewayTokens.list());
    } catch (error) {
      next(error);
    }
  });

  app.post(dashboardApi("/gateway-tokens"), requireControlAuth, requireCsrf, async (request, response, next) => {
    try {
      const { name } = gatewayTokenInputSchema.parse(request.body);
      response.status(201).json(await gatewayTokens.create(name));
    } catch (error) {
      next(error);
    }
  });

  app.delete(dashboardApi("/gateway-tokens/:id"), requireControlAuth, requireCsrf, async (request, response, next) => {
    try {
      const id = routeParameter(request.params.id, "id");
      await gatewayTokens.revoke(id);
      await mcpSessions.closeScopePrefix(`${id}:`);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.get(dashboardApi("/request-logs"), requireControlAuth, async (_request, response, next) => {
    try {
      response.json(await gatewayTokens.requestLogs());
    } catch (error) {
      next(error);
    }
  });

  app.post(dashboardApi("/gateway-token/rotate"), requireControlAuth, requireCsrf, async (_request, response, next) => {
    try {
      const result = await gatewayTokens.replaceAll("預設 Token");
      await mcpSessions.closeAll();
      response.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post(dashboardApi("/web-path/rotate"), requireControlAuth, requireCsrf, async (_request, response, next) => {
    try {
      const updated = await store.update((state) => {
        state.webPathUuid = randomUUID();
      });
      response.json({ webPath: webPathFromUuid(updated.webPathUuid) });
    } catch (error) {
      next(error);
    }
  });

  const mcpHandler = async (request: Request, response: Response, filterAlias?: string) => {
    const identity = await authenticateGateway(request, gatewayTokens);
    if (!identity) {
      response.status(401).setHeader("WWW-Authenticate", "Bearer").json({ error: "Invalid gateway token" });
      return;
    }
    const endpoint = filterAlias ? `/mcp/${filterAlias}` : "/mcp";
    const method = mcpRequestMethod(request);
    let failed = false;
    try {
      const scope = `${identity.id}:${filterAlias ?? "*"}`;
      const sessionId = request.header("mcp-session-id");
      if (sessionId) {
        const existing = mcpSessions.get(sessionId, scope);
        if (!existing) {
          response.status(404).json({ error: "Unknown MCP session" });
          return;
        }
        await existing.handleRequest(request, response, request.body);
        return;
      }
      const [{ isInitializeRequest }, { StreamableHTTPServerTransport }, { createGatewayServer }, upstreams] = await Promise.all([
        import("@modelcontextprotocol/sdk/types.js"),
        import("@modelcontextprotocol/sdk/server/streamableHttp.js"),
        import("./gateway-server.js"),
        getUpstreams(),
      ]);
      if (request.method !== "POST" || !isInitializeRequest(request.body)) {
        response.status(400).json({ error: "MCP initialization required" });
        return;
      }
      const server = createGatewayServer(upstreams, filterAlias, {
        onSuccessfulToolCall: () => gatewayTokens.recordSuccessfulToolCall(identity.id),
      });
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (id): void => {
          mcpSessions.register(id, scope, transport);
        },
        onsessionclosed: (id): void => {
          mcpSessions.delete(id);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) mcpSessions.delete(transport.sessionId);
      };
      try {
        await server.connect(transport);
        await transport.handleRequest(request, response, request.body);
      } catch (error) {
        await Promise.allSettled([server.close(), transport.close()]);
        throw error;
      }
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      const status = failed ? 500 : response.statusCode;
      await gatewayTokens.recordRequest(identity, {
        endpoint,
        method,
        outcome: failed || status >= 400 ? "error" : "success",
        status,
      }).catch((error: unknown) => {
        console.error("Failed to persist Gateway request usage:", error instanceof Error ? error.message : "Unknown error");
      });
    }
  };

  app.all("/mcp", (request, response, next) => void mcpHandler(request, response).catch(next));
  app.all("/mcp/:alias", (request, response, next) => {
    const alias = upstreamAliasSchema.parse(routeParameter(request.params.alias, "alias"));
    void mcpHandler(request, response, alias).catch(next);
  });

  const publicDirectory = join(fileURLToPath(new URL("..", import.meta.url)), "public");
  app.get(`${ASSET_PATH}/styles.css`, (_request, response) => response.sendFile(join(publicDirectory, "styles.css")));
  app.get(`${ASSET_PATH}/app.js`, (_request, response) => response.sendFile(join(publicDirectory, "app.js")));
  app.get(loginPath, (_request, response) => response.sendFile(join(publicDirectory, "index.html")));
  app.get(WEB_ROUTE, requirePageAuth(sessions, loginPath), (_request, response) => response.sendFile(join(publicDirectory, "index.html")));
  app.all([`${loginPath}/api/{*path}`, dashboardApi("/{*path}")], (_request, response) => response.status(404).json({ error: "找不到 API 路由" }));

  app.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    void next;
    if (error instanceof z.ZodError) {
      response.status(400).json({ error: error.issues[0]?.message ?? "輸入格式錯誤" });
      return;
    }
    const status = error instanceof HttpError || error instanceof GatewayTokenError
      ? error.status
      : expressErrorStatus(error)
        ?? (error instanceof AiConfigurationError || error instanceof WebSearchConfigurationError
          ? 400
          : error instanceof AiBusyError
            ? 429
            : error instanceof AiProviderError
              ? 502
              : error instanceof SearxngSearchError
                ? error.status && error.status >= 400 && error.status < 500 ? error.status : 502
            : 500);
    const message = error instanceof Error ? error.message : "伺服器發生未預期錯誤";
    response.status(status).json({ error: message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 500) });
  });

  return {
    app,
    close: () => mcpSessions.closeAll(),
  };
}

function expressErrorStatus(error: unknown): number | undefined {
  if (!(error instanceof Error) || !("status" in error)) return undefined;
  const status = error.status;
  return typeof status === "number" && status >= 400 && status < 500 ? status : undefined;
}

function installHostValidation(app: ReturnType<typeof express>, host: string): void {
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) return;
  const allowed = new Set(["localhost", "127.0.0.1", "[::1]"]);
  app.use((request, response, next) => {
    const hostHeader = request.headers.host;
    if (!hostHeader) {
      response.status(403).json({ jsonrpc: "2.0", error: { code: -32_000, message: "Missing Host header" }, id: null });
      return;
    }
    let hostname: string;
    try {
      hostname = new URL(`http://${hostHeader}`).hostname;
    } catch {
      response.status(403).json({ jsonrpc: "2.0", error: { code: -32_000, message: `Invalid Host header: ${hostHeader}` }, id: null });
      return;
    }
    if (!allowed.has(hostname)) {
      response.status(403).json({ jsonrpc: "2.0", error: { code: -32_000, message: `Invalid Host: ${hostname}` }, id: null });
      return;
    }
    next();
  });
}

async function currentWebPath(store: StateStore): Promise<string> {
  const current = await store.read();
  if (current.webPathUuid) return webPathFromUuid(current.webPathUuid);
  const updated = await store.update((state) => {
    state.webPathUuid ??= randomUUID();
  });
  return webPathFromUuid(updated.webPathUuid);
}

function webPathFromUuid(uuid: string | undefined): string {
  if (!uuid) throw new Error("Web path UUID was not initialized");
  return `/${uuid}/web`;
}

function requireCurrentWebPath(store: StateStore) {
  return async (request: Request, response: Response, next: NextFunction) => {
    try {
      const expected = await currentWebPath(store);
      const requestedUuid = routeParameter(request.params.webPathUuid, "webPathUuid");
      if (expected !== `/${requestedUuid}/web`) {
        response.status(404).send("Not Found");
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

function requirePageAuth(sessions: SessionManager, loginPath: string) {
  return (request: Request, response: Response, next: NextFunction) => {
    const token = parseCookie(request.headers.cookie, "mcp_nexus_session");
    if (!sessions.get(token)) {
      response.redirect(302, loginPath);
      return;
    }
    next();
  };
}

function routeParameter(value: string | string[] | undefined, name: string): string {
  if (typeof value !== "string" || !value) throw new HttpError(400, `Invalid ${name}`);
  return value;
}

function requireAuth(sessions: SessionManager, loginPath: string) {
  return (request: Request, response: Response, next: NextFunction) => {
    const sessionToken = parseCookie(request.headers.cookie, "mcp_nexus_session");
    const authSession = sessions.get(sessionToken);
    if (!sessionToken || !authSession) {
      response.status(401).json({ error: "請先登入", loginPath });
      return;
    }
    Object.assign(request, { authSession, sessionToken });
    next();
  };
}

function requireCsrf(request: Request, response: Response, next: NextFunction): void {
  const session = (request as AuthenticatedRequest).authSession;
  const token = request.header("x-csrf-token");
  if (!token || token !== session.csrfToken) {
    response.status(403).json({ error: "CSRF 驗證失敗" });
    return;
  }
  next();
}

async function authenticateGateway(
  request: Request,
  gatewayTokens: GatewayTokenService,
): Promise<GatewayTokenIdentity | undefined> {
  const token = request.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  return token ? gatewayTokens.authenticate(token) : undefined;
}

function mcpRequestMethod(request: Request): string {
  if (request.body && typeof request.body === "object" && "method" in request.body && typeof request.body.method === "string") {
    return request.body.method.slice(0, 100);
  }
  return request.method;
}

function setSessionCookie(response: Response, token: string): void {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  response.setHeader("Set-Cookie", `mcp_nexus_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure}`);
}

function toPublicUpstream(config: z.infer<typeof upstreamSchema>) {
  const { bearerToken, authParameters, ...publicConfig } = config;
  const hasCustomBearer = authParameters.some(({ location, name, value }) =>
    location === "header" && name.toLowerCase() === "authorization" && /^Bearer\s+/i.test(value));
  return {
    ...publicConfig,
    authParameterSummaries: authParameters.map(({ location, name }) => ({ location, name })),
    hasAuthentication: Boolean(bearerToken || authParameters.length),
    hasBearerToken: Boolean(bearerToken || hasCustomBearer),
    exportPath: `/mcp/${config.alias}`,
  };
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
