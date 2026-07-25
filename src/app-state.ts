import { z } from "zod";

export const administratorSchema = z.object({
  username: z.string().min(3).max(64),
  passwordSalt: z.string().min(1),
  passwordHash: z.string().min(1),
});

const defaultSystemPrompt = "Answer the search query clearly. Distinguish known facts from uncertainty.";
const defaultPlannerPrompt = "Break the question into a concise research plan. Identify facts to verify, ambiguities, and evaluation criteria. Do not claim to have used tools or live web access.";
const defaultResearcherPrompt = "Analyze the question from the assigned perspective. Separate established knowledge, inference, and uncertainty. Use the provided curl or searxng_search tools only when current external evidence is needed, and never claim tool use that did not occur. Remote MCP tools are unavailable.";
const defaultReviewerPrompt = "Audit the draft analysis for contradictions, unsupported claims, missing perspectives, and duplicated points. Return concrete corrections.";
const defaultSynthesizerPrompt = "Produce the final answer from the supplied agent outputs. Remove duplicates, preserve uncertainty, and answer the user's question directly.";

const aiSettingsFields = {
  baseUrl: z.string().url(),
  model: z.string().trim().min(1).max(200),
  apiKey: z.string(),
  systemPrompt: z.string().max(4_000),
};

export const aiSettingsSchema = z.object({
  baseUrl: aiSettingsFields.baseUrl.default("https://api.openai.com/v1"),
  model: aiSettingsFields.model.default("gpt-4.1-mini"),
  apiKey: aiSettingsFields.apiKey.default(""),
  systemPrompt: aiSettingsFields.systemPrompt.default(defaultSystemPrompt),
});
export const aiSettingsPatchSchema = z.object(aiSettingsFields).partial();

const searchOrchestrationFields = {
  mode: z.enum(["precision", "parallel", "custom"]),
  customConcurrency: z.number().int().min(1).max(8),
  historyCharLimit: z.number().int().min(1_000).max(48_000),
  maxOutputTokens: z.number().int().min(128).max(4_096),
  samplingMode: z.enum(["temperature", "top_p"]),
  temperature: z.number().min(0).max(2),
  topP: z.number().min(0.05).max(1),
  plannerPrompt: z.string().trim().min(1).max(4_000),
  researcherPrompt: z.string().trim().min(1).max(4_000),
  reviewerPrompt: z.string().trim().min(1).max(4_000),
  synthesizerPrompt: z.string().trim().min(1).max(4_000),
};

export const searchOrchestrationSchema = z.object({
  mode: searchOrchestrationFields.mode.default("precision"),
  customConcurrency: searchOrchestrationFields.customConcurrency.default(3),
  historyCharLimit: searchOrchestrationFields.historyCharLimit.default(12_000),
  maxOutputTokens: searchOrchestrationFields.maxOutputTokens.default(800),
  samplingMode: searchOrchestrationFields.samplingMode.default("temperature"),
  temperature: searchOrchestrationFields.temperature.default(0.2),
  topP: searchOrchestrationFields.topP.default(0.9),
  plannerPrompt: searchOrchestrationFields.plannerPrompt.default(defaultPlannerPrompt),
  researcherPrompt: searchOrchestrationFields.researcherPrompt.default(defaultResearcherPrompt),
  reviewerPrompt: searchOrchestrationFields.reviewerPrompt.default(defaultReviewerPrompt),
  synthesizerPrompt: searchOrchestrationFields.synthesizerPrompt.default(defaultSynthesizerPrompt),
});
export const searchOrchestrationPatchSchema = z.object(searchOrchestrationFields).partial();

export const webSearchSourceSchema = z.enum(["google", "bing", "duckduckgo", "startpage", "searxng"]);

const webSearchFields = {
  endpoint: z.union([z.literal(""), z.string().url()]),
  mode: z.enum(["single", "parallel"]),
  sources: z.array(webSearchSourceSchema).min(1).max(5).refine(
    (sources) => new Set(sources).size === sources.length,
    "搜尋來源不可重複",
  ),
  resultsPerSource: z.number().int().min(1).max(10),
  language: z.string().trim().min(1).max(20).regex(/^(?:all|[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?)$/),
  safeSearch: z.union([z.literal(0), z.literal(1), z.literal(2)]),
};

export const webSearchSettingsSchema = z.object({
  endpoint: webSearchFields.endpoint.default(""),
  mode: webSearchFields.mode.default("single"),
  sources: webSearchFields.sources.default(["searxng"]),
  resultsPerSource: webSearchFields.resultsPerSource.default(5),
  language: webSearchFields.language.default("all"),
  safeSearch: webSearchFields.safeSearch.default(1),
}).superRefine((settings, context) => {
  if (settings.mode === "single" && settings.sources.length !== 1) {
    context.addIssue({ code: "custom", path: ["sources"], message: "單一模式只能勾選一個搜尋來源" });
  }
});
export const webSearchSettingsPatchSchema = z.object(webSearchFields).partial();

export const upstreamAuthParameterSchema = z.object({
  location: z.enum(["header", "query"]),
  name: z.string().trim().min(1).max(100),
  value: z.string().min(1).max(8_000),
});

const forbiddenHeaderNames = new Set([
  "accept", "accept-charset", "accept-encoding", "connection", "content-length", "content-type", "cookie", "date",
  "expect", "host", "last-event-id", "mcp-protocol-version", "mcp-session-id", "origin", "referer", "set-cookie",
  "te", "trailer", "transfer-encoding", "upgrade", "via",
]);

export const upstreamAuthParametersSchema = z.array(upstreamAuthParameterSchema).max(20).superRefine((parameters, context) => {
  const seen = new Set<string>();
  let totalValueLength = 0;
  for (const [index, parameter] of parameters.entries()) {
    totalValueLength += parameter.value.length;
    const normalizedName = parameter.location === "header" ? parameter.name.toLowerCase() : parameter.name;
    const key = `${parameter.location}:${normalizedName}`;
    if (seen.has(key)) {
      context.addIssue({ code: "custom", path: [index, "name"], message: "認證參數名稱不可重複" });
    }
    seen.add(key);
    if (parameter.location === "header") {
      if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(parameter.name)) {
        context.addIssue({ code: "custom", path: [index, "name"], message: "HTTP Header 名稱格式無效" });
      }
      if (forbiddenHeaderNames.has(normalizedName) || normalizedName.startsWith("proxy-") || normalizedName.startsWith("sec-")) {
        context.addIssue({ code: "custom", path: [index, "name"], message: "此 HTTP Header 由連線協定管理，不能作為認證參數" });
      }
      if (containsControlCharacter(parameter.value)) {
        context.addIssue({ code: "custom", path: [index, "value"], message: "HTTP Header 值不可包含控制字元" });
      }
    } else if (!/^[A-Za-z0-9._~-]+$/.test(parameter.name)) {
      context.addIssue({ code: "custom", path: [index, "name"], message: "URL Query 名稱只能使用英數字及 . _ ~ -" });
    }
  }
  if (totalValueLength > 32_000) {
    context.addIssue({ code: "custom", message: "認證參數值的總長度不可超過 32000 字元" });
  }
});

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

export const upstreamAliasSchema = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);

export const upstreamSchema = z.object({
  id: z.string().uuid(),
  alias: upstreamAliasSchema,
  name: z.string().trim().min(1).max(100),
  endpoint: z.string().url(),
  bearerToken: z.string().max(8_000).default(""),
  authParameters: upstreamAuthParametersSchema.default([]),
  enabled: z.boolean().default(true),
  createdAt: z.string().datetime(),
});

export const gatewayTokenNameSchema = z.string().trim().min(1).max(80).refine(
  (value) => !containsControlCharacter(value),
  "Gateway Token 名稱不可包含控制字元",
);

export const gatewayTokenSchema = z.object({
  id: z.string().uuid(),
  name: gatewayTokenNameSchema,
  tokenSalt: z.string().min(1),
  tokenHash: z.string().min(1),
  tokenSuffix: z.string().regex(/^[A-Za-z0-9_-]{5}$/).optional(),
  requestCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  successfulToolCalls: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  createdAt: z.string().datetime(),
  lastUsedAt: z.string().datetime().optional(),
});

export const gatewayRequestLogSchema = z.object({
  id: z.string().uuid(),
  timestamp: z.string().datetime(),
  tokenId: z.string().uuid(),
  tokenName: gatewayTokenNameSchema,
  tokenSuffix: z.string().length(5).optional(),
  endpoint: z.string().min(1).max(160),
  method: z.string().min(1).max(100),
  outcome: z.enum(["success", "error"]),
  status: z.number().int().min(100).max(599),
});

const gatewayTokensSchema = z.array(gatewayTokenSchema).max(20).superRefine((tokens, context) => {
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const [index, token] of tokens.entries()) {
    const normalizedName = token.name.toLowerCase();
    if (ids.has(token.id)) {
      context.addIssue({ code: "custom", path: [index, "id"], message: "Gateway Token ID 不可重複" });
    }
    if (names.has(normalizedName)) {
      context.addIssue({ code: "custom", path: [index, "name"], message: "Gateway Token 名稱不可重複" });
    }
    ids.add(token.id);
    names.add(normalizedName);
  }
});

export const appStateSchema = z.object({
  administrator: administratorSchema.optional(),
  webPathUuid: z.string().uuid().optional(),
  ai: aiSettingsSchema.default({
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1-mini",
    apiKey: "",
    systemPrompt: defaultSystemPrompt,
  }),
  searchOrchestration: searchOrchestrationSchema.default({
    mode: "precision",
    customConcurrency: 3,
    historyCharLimit: 12_000,
    maxOutputTokens: 800,
    samplingMode: "temperature",
    temperature: 0.2,
    topP: 0.9,
    plannerPrompt: defaultPlannerPrompt,
    researcherPrompt: defaultResearcherPrompt,
    reviewerPrompt: defaultReviewerPrompt,
    synthesizerPrompt: defaultSynthesizerPrompt,
  }),
  webSearch: webSearchSettingsSchema.default({
    endpoint: "",
    mode: "single",
    sources: ["searxng"],
    resultsPerSource: 5,
    language: "all",
    safeSearch: 1,
  }),
  upstreams: z.array(upstreamSchema).default([]),
  gatewayTokens: gatewayTokensSchema.default([]),
  gatewayRequestLogs: z.array(gatewayRequestLogSchema).max(200).default([]),
  gatewayTokenSalt: z.string().optional(),
  gatewayTokenHash: z.string().optional(),
});

export type AppState = z.infer<typeof appStateSchema>;
export type AiSettings = z.infer<typeof aiSettingsSchema>;
export type SearchOrchestration = z.infer<typeof searchOrchestrationSchema>;
export type WebSearchSettings = z.infer<typeof webSearchSettingsSchema>;
export type WebSearchSource = z.infer<typeof webSearchSourceSchema>;
export type UpstreamAuthParameter = z.infer<typeof upstreamAuthParameterSchema>;
export type UpstreamConfig = z.infer<typeof upstreamSchema>;
export type GatewayToken = z.infer<typeof gatewayTokenSchema>;
export type GatewayRequestLog = z.infer<typeof gatewayRequestLogSchema>;

export const defaultAppState = (): AppState => appStateSchema.parse({});
