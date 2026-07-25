import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadStartupConfig } from "../src/startup-config.js";
import { startWebServer } from "../src/web-server.js";

describe("web startup configuration and lifecycle", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  async function createProject(contents = "HOST=127.0.0.1\nPORT=3137\nWEB_LOGIN_PATH=/from-env/login\nMCP_NEXUS_DATA=data/custom.json\n") {
    const directory = await mkdtemp(join(tmpdir(), "mcp-nexus-config-"));
    directories.push(directory);
    await writeFile(join(directory, ".env"), contents, "utf8");
    return directory;
  }

  it("loads .env and relative state from the project root while preserving shell and panel priority", async () => {
    const projectRoot = await createProject();
    const direct = loadStartupConfig({ projectRoot, environment: {} });
    expect(direct).toMatchObject({ host: "127.0.0.1", port: 3137, loginPath: "/from-env/login" });
    expect(direct.dataPath).toBe(join(projectRoot, "data", "custom.json"));

    const panel = loadStartupConfig({ projectRoot, environment: { SERVER_PORT: "25570", P_SERVER_UUID: "id" } });
    expect(panel).toMatchObject({ host: "0.0.0.0", port: 25570 });
    const explicit = loadStartupConfig({ projectRoot, environment: { HOST: "127.0.0.1", PORT: "40123", SERVER_PORT: "25570" } });
    expect(explicit).toMatchObject({ host: "127.0.0.1", port: 40123 });
  });

  it("rejects missing configuration and occupied ports without leaving runtime resources open", async () => {
    const missing = await mkdtemp(join(tmpdir(), "mcp-nexus-config-"));
    directories.push(missing);
    expect(() => loadStartupConfig({ projectRoot: missing, environment: {} })).toThrow("Missing or empty .env");

    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(0, "127.0.0.1", resolve);
    });
    const port = (blocker.address() as AddressInfo).port;
    const projectRoot = await createProject(`WEB_LOGIN_PATH=/login\nMCP_NEXUS_DATA=data/state.json\n`);
    await expect(startWebServer({ projectRoot, environment: { HOST: "127.0.0.1", PORT: String(port) } })).rejects.toMatchObject({ code: "EADDRINUSE" });
    await new Promise<void>((resolve, reject) => blocker.close((error) => error ? reject(error) : resolve()));
  });
});
