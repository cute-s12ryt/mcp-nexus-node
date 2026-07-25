import { randomUUID } from "node:crypto";

import { gatewayTokenNameSchema, type AppState, type GatewayRequestLog, type GatewayToken } from "./app-state.js";
import { digestToken, generateToken, verifySecret, verifyToken } from "./security.js";
import type { StateStore } from "./state-store.js";

const MAX_GATEWAY_TOKENS = 20;
const MAX_REQUEST_LOGS = 200;

export interface GatewayTokenIdentity {
  id: string;
  name: string;
  tokenSuffix?: string;
}

export interface PublicGatewayToken extends GatewayTokenIdentity {
  requestCount: number;
  successfulToolCalls: number;
  createdAt: string;
  lastUsedAt?: string;
}

export class GatewayTokenError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export class GatewayTokenService {
  constructor(private readonly store: StateStore) {}

  async list(): Promise<PublicGatewayToken[]> {
    const state = await this.readMigratedState();
    return state.gatewayTokens.map(toPublicToken);
  }

  async create(name: string): Promise<{ gatewayToken: string; token: PublicGatewayToken }> {
    name = gatewayTokenNameSchema.parse(name);
    const plaintext = generateToken();
    const createdAt = new Date().toISOString();
    const token: GatewayToken = {
      id: randomUUID(),
      name,
      tokenSalt: "sha256",
      tokenHash: digestToken(plaintext),
      tokenSuffix: plaintext.slice(-5),
      requestCount: 0,
      successfulToolCalls: 0,
      createdAt,
    };
    await this.readMigratedState();
    await this.store.update((state) => {
      if (state.gatewayTokens.length >= MAX_GATEWAY_TOKENS) {
        throw new GatewayTokenError(409, `Gateway Token 最多可建立 ${MAX_GATEWAY_TOKENS} 組`);
      }
      if (state.gatewayTokens.some((existing) => existing.name.toLowerCase() === name.toLowerCase())) {
        throw new GatewayTokenError(409, "Gateway Token 名稱已存在");
      }
      state.gatewayTokens.push(token);
    });
    return { gatewayToken: plaintext, token: toPublicToken(token) };
  }

  async replaceAll(name: string): Promise<{ gatewayToken: string; token: PublicGatewayToken }> {
    const plaintext = generateToken();
    const token: GatewayToken = {
      id: randomUUID(),
      name,
      tokenSalt: "sha256",
      tokenHash: digestToken(plaintext),
      tokenSuffix: plaintext.slice(-5),
      requestCount: 0,
      successfulToolCalls: 0,
      createdAt: new Date().toISOString(),
    };
    await this.store.update((state) => {
      state.gatewayTokens = [token];
      state.gatewayTokenSalt = undefined;
      state.gatewayTokenHash = undefined;
    });
    return { gatewayToken: plaintext, token: toPublicToken(token) };
  }

  async revoke(id: string): Promise<void> {
    await this.readMigratedState();
    await this.store.update((state) => {
      const index = state.gatewayTokens.findIndex((token) => token.id === id);
      if (index < 0) throw new GatewayTokenError(404, "找不到 Gateway Token");
      if (state.gatewayTokens.length === 1) throw new GatewayTokenError(409, "至少需要保留一組 Gateway Token");
      state.gatewayTokens.splice(index, 1);
    });
  }

  async authenticate(plaintext: string): Promise<GatewayTokenIdentity | undefined> {
    const state = await this.readMigratedState();
    for (const token of state.gatewayTokens) {
      const valid = token.tokenSalt === "sha256"
        ? verifyToken(plaintext, token.tokenHash)
        : await verifySecret(plaintext, { salt: token.tokenSalt, hash: token.tokenHash });
      if (valid) return { id: token.id, name: token.name, tokenSuffix: token.tokenSuffix };
    }
    return undefined;
  }

  async recordRequest(
    identity: GatewayTokenIdentity,
    details: Pick<GatewayRequestLog, "endpoint" | "method" | "outcome" | "status">,
  ): Promise<void> {
    const timestamp = new Date().toISOString();
    await this.store.update((state) => {
      const token = state.gatewayTokens.find(({ id }) => id === identity.id);
      if (token) {
        token.requestCount = increment(token.requestCount);
        token.lastUsedAt = timestamp;
      }
      state.gatewayRequestLogs.unshift({
        id: randomUUID(),
        timestamp,
        tokenId: identity.id,
        tokenName: identity.name,
        tokenSuffix: identity.tokenSuffix,
        ...details,
      });
      state.gatewayRequestLogs.splice(MAX_REQUEST_LOGS);
    });
  }

  async recordSuccessfulToolCall(tokenId: string): Promise<void> {
    await this.store.update((state) => {
      const token = state.gatewayTokens.find(({ id }) => id === tokenId);
      if (token) token.successfulToolCalls = increment(token.successfulToolCalls);
    });
  }

  async requestLogs(): Promise<GatewayRequestLog[]> {
    return (await this.readMigratedState()).gatewayRequestLogs;
  }

  private async readMigratedState(): Promise<AppState> {
    const state = await this.store.read();
    if (!state.gatewayTokenHash || !state.gatewayTokenSalt) return state;
    return this.store.update((draft) => {
      if (!draft.gatewayTokenHash || !draft.gatewayTokenSalt) return;
      if (draft.gatewayTokens.length >= MAX_GATEWAY_TOKENS) {
        throw new GatewayTokenError(409, "無法遷移舊 Gateway Token：Token 數量已達上限");
      }
      draft.gatewayTokens.push({
        id: randomUUID(),
        name: uniqueLegacyName(draft.gatewayTokens),
        tokenSalt: draft.gatewayTokenSalt,
        tokenHash: draft.gatewayTokenHash,
        requestCount: 0,
        successfulToolCalls: 0,
        createdAt: new Date().toISOString(),
      });
      draft.gatewayTokenSalt = undefined;
      draft.gatewayTokenHash = undefined;
    });
  }
}

function toPublicToken(token: GatewayToken): PublicGatewayToken {
  return {
    id: token.id,
    name: token.name,
    tokenSuffix: token.tokenSuffix,
    requestCount: token.requestCount,
    successfulToolCalls: token.successfulToolCalls,
    createdAt: token.createdAt,
    lastUsedAt: token.lastUsedAt,
  };
}

function uniqueLegacyName(tokens: GatewayToken[]): string {
  const names = new Set(tokens.map(({ name }) => name.toLowerCase()));
  if (!names.has("預設 token")) return "預設 Token";
  let suffix = 2;
  while (names.has(`預設 token ${suffix}`)) suffix += 1;
  return `預設 Token ${suffix}`;
}

function increment(value: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, value + 1);
}
