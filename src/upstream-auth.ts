import type { UpstreamConfig } from "./app-state.js";

export interface UpstreamRequestAuthentication {
  endpoint: URL;
  headers: Record<string, string>;
}

export function applyUpstreamAuthentication(config: UpstreamConfig, safeEndpoint: URL): UpstreamRequestAuthentication {
  const endpoint = new URL(safeEndpoint.href);
  const headers: Record<string, string> = {};
  if (config.bearerToken) headers.Authorization = `Bearer ${config.bearerToken}`;
  for (const parameter of config.authParameters) {
    if (parameter.location === "header") setHeader(headers, parameter.name, parameter.value);
    else endpoint.searchParams.set(parameter.name, parameter.value);
  }
  return { endpoint, headers };
}

function setHeader(headers: Record<string, string>, name: string, value: string): void {
  const normalizedName = name.toLowerCase();
  for (const existingName of Object.keys(headers)) {
    if (existingName.toLowerCase() === normalizedName) delete headers[existingName];
  }
  headers[name] = value;
}

export function redactUpstreamAuthentication(error: unknown, config: UpstreamConfig): Error {
  const source = error instanceof Error ? error.message : String(error);
  const secrets = [config.bearerToken, ...config.authParameters.map(({ value }) => value)].filter(Boolean);
  const message = secrets.reduce((current, secret) => {
    const formEncoded = new URLSearchParams({ value: secret }).toString().slice("value=".length);
    return current
      .replaceAll(secret, "[redacted]")
      .replaceAll(encodeURIComponent(secret), "[redacted]")
      .replaceAll(formEncoded, "[redacted]");
  }, source);
  return new Error(message);
}
