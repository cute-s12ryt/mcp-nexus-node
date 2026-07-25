#!/usr/bin/env node
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { JsonStateStore } from "./state-store.js";
import { loadStartupConfig, type StartupConfigOptions } from "./startup-config.js";
import { createWebRuntime } from "./web-app.js";

export interface RunningWebServer {
  server: Server;
  loginUrl: string;
  close(): Promise<void>;
}

export interface WebServerOptions extends StartupConfigOptions {
  shutdownTimeoutMs?: number;
}

export async function startWebServer(options: WebServerOptions = {}): Promise<RunningWebServer> {
  const settings = loadStartupConfig(options);
  const runtime = createWebRuntime(new JsonStateStore(settings.dataPath), {
    host: settings.host,
    loginPath: settings.loginPath,
  });
  const server = createServer(runtime.app);
  try {
    await listen(server, settings.port, settings.host);
  } catch (error) {
    await runtime.close();
    throw error;
  }

  let closePromise: Promise<void> | undefined;
  const close = () => closePromise ??= closeServer(server, runtime.close, options.shutdownTimeoutMs ?? 5_000);
  return {
    server,
    loginUrl: `http://${settings.host}:${settings.port}${settings.loginPath}`,
    close,
  };
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

async function closeServer(server: Server, closeRuntime: () => Promise<void>, timeoutMs: number): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  const closed = new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
    server.closeIdleConnections();
  });
  const gracefulClose = Promise.allSettled([closed, closeRuntime()]).then((results) => {
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
  });
  const deadline = new Promise<void>((_resolve, reject) => {
    timeout = setTimeout(() => {
      server.closeAllConnections();
      reject(new Error(`HTTP shutdown exceeded ${timeoutMs}ms; forced open connections closed`));
    }, timeoutMs);
    timeout.unref();
  });
  try {
    await Promise.race([gracefulClose, deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function runWebServerCli(options: WebServerOptions = {}): Promise<RunningWebServer> {
  const running = await startWebServer(options);
  console.log(`MCP Nexus login available at ${running.loginUrl}`);
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] Received ${signal}; closing HTTP and MCP sessions.`);
    void running.close()
      .catch((error: unknown) => {
        console.error(`[shutdown] ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      })
      .finally(() => {
        process.off("SIGINT", onSigint);
        process.off("SIGTERM", onSigterm);
      });
  };
  const onSigint = () => shutdown("SIGINT");
  const onSigterm = () => shutdown("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  return running;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  runWebServerCli().catch((error: unknown) => {
    console.error(`[startup] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
