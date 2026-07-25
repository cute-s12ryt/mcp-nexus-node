import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { upstreamSchema } from "../src/app-state.js";
import { assertSafeRemoteUrl } from "../src/network-policy.js";
import { JsonStateStore } from "../src/state-store.js";
import { applyUpstreamAuthentication, redactUpstreamAuthentication } from "../src/upstream-auth.js";
import { normalizeLoginPath } from "../src/web-app.js";

describe("state and outbound network boundaries", () => {
  const directories: string[] = [];

  afterEach(async () => {
    delete process.env.ALLOW_PRIVATE_UPSTREAMS;
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("recovers the write queue after a failed update", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mcp-nexus-"));
    directories.push(directory);
    const store = new JsonStateStore(join(directory, "state.json"));

    await expect(store.update(() => { throw new Error("intentional failure"); })).rejects.toThrow("intentional failure");
    const recovered = await store.update((state) => { state.ai.model = "recovered-model"; });
    expect(recovered.ai.model).toBe("recovered-model");
  });

  it("keeps validated state cached while returning isolated snapshots", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mcp-nexus-"));
    directories.push(directory);
    const statePath = join(directory, "state.json");
    const store = new JsonStateStore(statePath);
    await store.update((state) => { state.ai.model = "cached-model"; });

    const first = await store.read();
    first.ai.model = "mutated-outside-store";
    await writeFile(statePath, "not valid JSON", "utf8");

    expect((await store.read()).ai.model).toBe("cached-model");
    await store.update((state) => { state.ai.systemPrompt = "persisted-after-cache"; });

    const reloaded = new JsonStateStore(statePath);
    const diskState = await reloaded.read();
    expect(diskState.ai.model).toBe("cached-model");
    expect(diskState.ai.systemPrompt).toBe("persisted-after-cache");
  });

  it("serializes concurrent cached updates without losing changes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mcp-nexus-"));
    directories.push(directory);
    const store = new JsonStateStore(join(directory, "state.json"));
    await store.update((state) => { state.ai.systemPrompt = ""; });

    await Promise.all(Array.from({ length: 25 }, (_, index) => store.update((state) => {
      state.ai.systemPrompt += String.fromCharCode(65 + index);
    })));

    expect((await store.read()).ai.systemPrompt).toBe("ABCDEFGHIJKLMNOPQRSTUVWXY");
  });

  it.each(["http://127.0.0.1:3000/mcp", "https://10.0.0.1/mcp", "https://[::1]/mcp"])(
    "blocks private endpoint %s",
    async (endpoint) => {
      await expect(assertSafeRemoteUrl(endpoint)).rejects.toThrow();
    },
  );

  it("allows explicit private development endpoints", async () => {
    process.env.ALLOW_PRIVATE_UPSTREAMS = "true";
    await expect(assertSafeRemoteUrl("http://127.0.0.1:3000/mcp")).resolves.toBeInstanceOf(URL);
  });

  it("accepts nested login paths and rejects unsafe or reserved paths", () => {
    expect(normalizeLoginPath(" /yoyo/s12ryt/login ")).toBe("/yoyo/s12ryt/login");
    for (const path of ["login", "/api/login", "/mcp/login", "/_mcp-nexus/login", "/login/", "/login?next=/web", "/../login"]) {
      expect(() => normalizeLoginPath(path)).toThrow();
    }
  });

  it("keeps legacy bearer data compatible and applies custom header and query authentication", () => {
    const config = upstreamSchema.parse({
      id: crypto.randomUUID(),
      alias: "secure",
      name: "Secure MCP",
      endpoint: "https://mcp.example.com/service?existing=kept",
      bearerToken: "legacy-token",
      authParameters: [
        { location: "header", name: "authorization", value: "Custom newer-token" },
        { location: "header", name: "X-API-Key", value: "header-secret" },
        { location: "query", name: "api_key", value: "a+b & c" },
      ],
      enabled: true,
      createdAt: new Date().toISOString(),
    });
    const authentication = applyUpstreamAuthentication(config, new URL(config.endpoint));
    expect(authentication.headers).toEqual({ authorization: "Custom newer-token", "X-API-Key": "header-secret" });
    expect(authentication.endpoint.searchParams.get("existing")).toBe("kept");
    expect(authentication.endpoint.searchParams.get("api_key")).toBe("a+b & c");
    const redacted = redactUpstreamAuthentication(new Error(authentication.endpoint.href), config).message;
    expect(redacted).not.toContain("a%2Bb+%26+c");
    expect(redacted).toContain("api_key=[redacted]");

    const legacy = upstreamSchema.parse({ ...config, authParameters: undefined });
    expect(legacy.authParameters).toEqual([]);
    expect(applyUpstreamAuthentication(legacy, new URL(legacy.endpoint)).headers.Authorization).toBe("Bearer legacy-token");
  });

  it("rejects duplicate, reserved, or malformed authentication parameter names", () => {
    const base = {
      id: crypto.randomUUID(), alias: "invalid", name: "Invalid MCP", endpoint: "https://mcp.example.com/mcp",
      enabled: true, createdAt: new Date().toISOString(),
    };
    expect(() => upstreamSchema.parse({
      ...base,
      authParameters: [
        { location: "header", name: "X-API-Key", value: "one" },
        { location: "header", name: "x-api-key", value: "two" },
      ],
    })).toThrow("認證參數名稱不可重複");
    expect(() => upstreamSchema.parse({
      ...base,
      authParameters: [{ location: "header", name: "Mcp-Session-Id", value: "secret" }],
    })).toThrow("不能作為認證參數");
    expect(() => upstreamSchema.parse({
      ...base,
      authParameters: [{ location: "query", name: "api key", value: "secret" }],
    })).toThrow("URL Query 名稱");
    expect(() => upstreamSchema.parse({
      ...base,
      authParameters: [{ location: "header", name: "Authorization", value: "Bearer safe\r\nX-Injected: yes" }],
    })).toThrow("控制字元");
  });
});
