export interface RuntimeLimits {
  maxMcpSessions: number;
  mcpSessionIdleMs: number;
  maxUpstreamTools: number;
  maxAiResponseBytes: number;
}

export function readRuntimeLimits(environment: NodeJS.ProcessEnv = process.env): RuntimeLimits {
  return {
    maxMcpSessions: readInteger(environment, "MCP_MAX_SESSIONS", 8, 1, 64),
    mcpSessionIdleMs: readInteger(environment, "MCP_SESSION_IDLE_MS", 15 * 60_000, 30_000, 24 * 60 * 60_000),
    maxUpstreamTools: readInteger(environment, "MCP_MAX_TOOLS", 256, 1, 2_048),
    maxAiResponseBytes: readInteger(environment, "MCP_MAX_AI_RESPONSE_BYTES", 1024 * 1024, 16 * 1024, 8 * 1024 * 1024),
  };
}

function readInteger(environment: NodeJS.ProcessEnv, name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = environment[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}
