import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadDotenv } from "dotenv";

export interface StartupConfig {
  projectRoot: string;
  host: string;
  port: number;
  dataPath: string;
  loginPath: string;
}

export interface StartupConfigOptions {
  projectRoot?: string;
  environment?: NodeJS.ProcessEnv;
}

export const defaultProjectRoot = fileURLToPath(new URL("..", import.meta.url));

export function normalizeLoginPath(value: string): string {
  const path = value.trim();
  if (path.length > 200 || !/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(path)) {
    throw new Error("WEB_LOGIN_PATH must be an absolute path using only letters, numbers, underscores, and hyphens");
  }
  const firstSegment = path.split("/")[1]?.toLowerCase();
  if (["api", "mcp", "_mcp-nexus"].includes(firstSegment ?? "") || /^\/[0-9a-f-]{36}\/web$/i.test(path)) {
    throw new Error("WEB_LOGIN_PATH conflicts with a reserved application route");
  }
  return path;
}

export function loadStartupConfig(options: StartupConfigOptions = {}): StartupConfig {
  const projectRoot = resolve(options.projectRoot ?? defaultProjectRoot);
  const environment = options.environment ?? process.env;
  const environmentPath = resolve(projectRoot, ".env");
  assertEnvironmentFile(environmentPath);

  const explicitHost = environment.HOST;
  const explicitPort = environment.PORT;
  const panelPort = environment.SERVER_PORT;
  const panelEnvironment = Boolean(environment.P_SERVER_UUID || panelPort);
  const result = loadDotenv({ path: environmentPath, processEnv: environment, quiet: true });
  if (result.error) throw result.error;

  const host = explicitHost ?? (panelEnvironment ? "0.0.0.0" : environment.HOST ?? "127.0.0.1");
  const portValue = explicitPort ?? panelPort ?? environment.PORT ?? "3000";
  const port = Number.parseInt(portValue, 10);
  if (!Number.isInteger(port) || String(port) !== portValue.trim() || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  environment.HOST = host;
  environment.PORT = String(port);
  return {
    projectRoot,
    host,
    port,
    dataPath: resolve(projectRoot, environment.MCP_NEXUS_DATA ?? "data/state.json"),
    loginPath: normalizeLoginPath(environment.WEB_LOGIN_PATH ?? "/login"),
  };
}

function assertEnvironmentFile(path: string): void {
  try {
    if (!statSync(path).isFile() || readFileSync(path, "utf8").trim().length === 0) throw new Error();
  } catch {
    throw new Error(`Missing or empty .env at ${path}. Create it from .env.example and fill in the required values.`);
  }
}
