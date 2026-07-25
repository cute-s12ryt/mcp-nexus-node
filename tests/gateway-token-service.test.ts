import { describe, expect, it } from "vitest";

import { defaultAppState } from "../src/app-state.js";
import { GatewayTokenError, GatewayTokenService } from "../src/gateway-token-service.js";
import { digestToken, generateToken } from "../src/security.js";
import { InMemoryStateStore } from "../src/state-store.js";

describe("GatewayTokenService", () => {
  it("migrates and authenticates the legacy single token without inventing a suffix", async () => {
    const plaintext = generateToken();
    const state = defaultAppState();
    state.gatewayTokenSalt = "sha256";
    state.gatewayTokenHash = digestToken(plaintext);
    const store = new InMemoryStateStore(state);
    const service = new GatewayTokenService(store);

    await expect(service.authenticate(plaintext)).resolves.toMatchObject({ name: "預設 Token" });
    const tokens = await service.list();
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.tokenSuffix).toBeUndefined();
    const migrated = await store.read();
    expect(migrated.gatewayTokenSalt).toBeUndefined();
    expect(migrated.gatewayTokenHash).toBeUndefined();
  });

  it("creates independent tokens, persists both counters, and retains only 200 request logs", async () => {
    const store = new InMemoryStateStore();
    const service = new GatewayTokenService(store);
    const first = await service.create("Claude Desktop");
    const second = await service.create("Automation");

    expect(first.token.tokenSuffix).toBe(first.gatewayToken.slice(-5));
    await expect(service.authenticate(second.gatewayToken)).resolves.toMatchObject({ id: second.token.id, name: "Automation" });
    for (let index = 0; index < 201; index += 1) {
      await service.recordRequest(second.token, {
        endpoint: "/mcp",
        method: index === 200 ? "tools/call" : "tools/list",
        outcome: "success",
        status: 200,
      });
    }
    await service.recordSuccessfulToolCall(second.token.id);

    const tokens = await service.list();
    expect(tokens.find(({ id }) => id === first.token.id)?.requestCount).toBe(0);
    expect(tokens.find(({ id }) => id === second.token.id)).toMatchObject({ requestCount: 201, successfulToolCalls: 1 });
    const logs = await service.requestLogs();
    expect(logs).toHaveLength(200);
    expect(logs[0]).toMatchObject({ tokenName: "Automation", method: "tools/call" });
    expect(JSON.stringify(logs)).not.toContain(second.gatewayToken);
  });

  it("rejects duplicate names and prevents revoking the final token", async () => {
    const service = new GatewayTokenService(new InMemoryStateStore());
    const created = await service.create("Primary");
    await expect(service.create("primary")).rejects.toMatchObject({ status: 409 });
    await expect(service.revoke(created.token.id)).rejects.toBeInstanceOf(GatewayTokenError);
  });

  it("rejects ambiguous persisted identities and unsafe display names", async () => {
    const state = defaultAppState();
    const id = crypto.randomUUID();
    const baseToken = {
      id,
      name: "Primary",
      tokenSalt: "sha256",
      tokenHash: digestToken(generateToken()),
      tokenSuffix: "abcde",
      requestCount: 0,
      successfulToolCalls: 0,
      createdAt: new Date().toISOString(),
    };
    state.gatewayTokens = [baseToken, { ...baseToken, name: "Secondary" }];
    expect(() => new InMemoryStateStore(state)).toThrow(/Gateway Token ID/);

    const service = new GatewayTokenService(new InMemoryStateStore());
    await expect(service.create("unsafe\nname")).rejects.toThrow(/控制字元/);
  });
});
