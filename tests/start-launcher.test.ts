import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertEnvironmentFile,
  createRuntimeEnvironment,
  ensureCompiledEntry,
  findMissingRuntimeDependencies,
  getInstallStep,
  resolveSpawnInvocation,
  resolveSourceLoader,
} from "../start.js";

describe("Pterodactyl startup launcher", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  async function createProject() {
    const directory = await mkdtemp(join(tmpdir(), "mcp-nexus-start-"));
    directories.push(directory);
    await writeFile(join(directory, ".env"), "WEB_LOGIN_PATH=/login\n", "utf8");
    return directory;
  }

  it("requires a real .env file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mcp-nexus-start-"));
    directories.push(directory);
    expect(() => assertEnvironmentFile(directory)).toThrow("Missing or empty .env");
    await mkdir(join(directory, ".env"));
    expect(() => assertEnvironmentFile(directory)).toThrow("Missing or empty .env");
    await rm(join(directory, ".env"), { recursive: true });
    await writeFile(join(directory, ".env"), "   \n", "utf8");
    expect(() => assertEnvironmentFile(directory)).toThrow("Missing or empty .env");
  });

  it("uses npm ci when a lockfile is present", async () => {
    const directory = await createProject();
    await writeFile(join(directory, "package-lock.json"), "{}", "utf8");
    expect(getInstallStep(directory).args).toEqual(["ci", "--include=dev"]);
  });

  it("installs, builds, and selects the generated web entrypoint", async () => {
    const directory = await createProject();
    await writeFile(join(directory, "package-lock.json"), "{}", "utf8");
    const runner = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === "run") {
        await mkdir(join(directory, "dist"));
        await writeFile(join(directory, "dist", "web-server.js"), "", "utf8");
      }
      return true;
    });

    await expect(ensureCompiledEntry(directory, runner, () => [])).resolves.toBe(join(directory, "dist", "web-server.js"));
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls[0]?.[1]).toEqual(["ci", "--include=dev"]);
    expect(runner.mock.calls[1]?.[1]).toEqual(["run", "build"]);
  });

  it("falls back when installation or build cannot produce dist", async () => {
    const directory = await createProject();
    await expect(ensureCompiledEntry(directory, async () => false)).resolves.toBeUndefined();
    await expect(ensureCompiledEntry(directory, async () => true)).resolves.toBeUndefined();
  });

  it("detects missing runtime dependencies and repairs an existing build", async () => {
    const directory = await createProject();
    await mkdir(join(directory, "dist"));
    await writeFile(join(directory, "dist", "web-server.js"), "", "utf8");
    await writeFile(join(directory, "package.json"), JSON.stringify({ dependencies: { "missing-runtime-package": "1.0.0" } }), "utf8");
    expect(findMissingRuntimeDependencies(directory)).toEqual(["missing-runtime-package"]);

    let repaired = false;
    const runner = vi.fn(async () => { repaired = true; return true; });
    await expect(ensureCompiledEntry(directory, runner, () => repaired ? [] : ["missing-runtime-package"]))
      .resolves.toBe(join(directory, "dist", "web-server.js"));
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("detects packages whose root is intentionally not exported", async () => {
    const directory = await createProject();
    const packageDirectory = join(directory, "node_modules", "@fixture", "subpaths-only");
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(join(directory, "package.json"), JSON.stringify({ dependencies: { "@fixture/subpaths-only": "1.0.0" } }), "utf8");
    await writeFile(join(packageDirectory, "package.json"), JSON.stringify({
      name: "@fixture/subpaths-only",
      exports: { "./feature": "./feature.js" },
    }), "utf8");
    expect(findMissingRuntimeDependencies(directory)).toEqual([]);
  });

  it("runs Windows command shims through ComSpec without enabling a shell", () => {
    expect(resolveSpawnInvocation("npm.cmd", ["ci", "--include=dev"], "win32", "C:\\Windows\\System32\\cmd.exe")).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "npm.cmd", "ci", "--include=dev"],
    });
    expect(resolveSpawnInvocation("npm", ["ci"], "linux")).toEqual({ command: "npm", args: ["ci"] });
  });

  it("resolves the TypeScript loader from the project instead of the caller working directory", async () => {
    const directory = await createProject();
    const packageDirectory = join(directory, "node_modules", "tsx");
    await mkdir(join(packageDirectory, "dist"), { recursive: true });
    await writeFile(join(directory, "package.json"), "{}", "utf8");
    await writeFile(join(packageDirectory, "package.json"), JSON.stringify({
      name: "tsx",
      type: "module",
      exports: { ".": "./dist/loader.mjs" },
    }), "utf8");
    await writeFile(join(packageDirectory, "dist", "loader.mjs"), "", "utf8");
    expect(resolveSourceLoader(directory)).toBe(pathToFileURL(join(packageDirectory, "dist", "loader.mjs")).href);
  });

  it("maps Pterodactyl allocation variables without overriding explicit values", () => {
    expect(createRuntimeEnvironment({ SERVER_PORT: "25570", P_SERVER_UUID: "server-id" })).toMatchObject({
      HOST: "0.0.0.0",
      PORT: "25570",
    });
    expect(createRuntimeEnvironment({ HOST: "127.0.0.1", PORT: "3137", SERVER_PORT: "25570" })).toMatchObject({
      HOST: "127.0.0.1",
      PORT: "3137",
    });
  });
});
