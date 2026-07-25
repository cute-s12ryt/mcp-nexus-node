import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { resolveSourceLoader } from "../start.js";
import { loadStartupConfig } from "../src/startup-config.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

describe("web entrypoint process lifecycle", () => {
  it("starts source code outside the project cwd and closes cleanly on SIGTERM", async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), "mcp-nexus-process-"));
    await writeFile(join(workingDirectory, ".env"), "WEB_LOGIN_PATH=/integration/login\n", "utf8");
    const port = await findAvailablePort();
    const environment = {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      MCP_NEXUS_DATA: join(workingDirectory, "state.json"),
    };
    delete environment.WEB_LOGIN_PATH;
    const settings = loadStartupConfig({ projectRoot: workingDirectory, environment: { ...environment } });
    const webServerUrl = pathToFileURL(join(projectRoot, "src", "web-server.ts")).href;
    const harness = [
      `const { runWebServerCli } = await import(${JSON.stringify(webServerUrl)});`,
      `await runWebServerCli({ projectRoot: ${JSON.stringify(workingDirectory)} });`,
      "process.on('message', (message) => {",
      "  if (message === 'SIGTERM') {",
      "    process.emit('SIGTERM');",
      "    process.disconnect();",
      "  }",
      "});",
    ].join("\n");
    const child = spawn(process.execPath, [
      "--import",
      resolveSourceLoader(projectRoot),
      "--input-type=module",
      "--eval",
      harness,
    ], {
      cwd: workingDirectory,
      env: environment,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });

    try {
      await waitForHttp(`http://127.0.0.1:${port}${settings.loginPath}/api/status`, child);
      const exited = waitForExit(child);
      child.send("SIGTERM");
      const result = await exited;
      expect(result).toEqual({ code: 0, signal: null });
      expect(output).toContain("[shutdown] Received SIGTERM; closing HTTP and MCP sessions.");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await rm(workingDirectory, { recursive: true, force: true });
    }
  }, 20_000);
});

function findAvailablePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to allocate a test port"));
        return;
      }
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

async function waitForHttp(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("Web process exited before accepting HTTP requests");
    try {
      const response = await fetch(url);
      if (response.status === 200) return;
    } catch {
      // The listener may still be starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("Timed out waiting for the web process");
}

function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolveExit, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for graceful shutdown")), 10_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolveExit({ code, signal });
    });
  });
}
