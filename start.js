#!/usr/bin/env node
import { spawn } from "node:child_process";
import { error as logError, log, warn } from "node:console";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const launcherPath = fileURLToPath(import.meta.url);
const defaultProjectRoot = dirname(launcherPath);
const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";

let activeChild;
let shutdownSignal;
const signalHandlers = new Map();

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function assertEnvironmentFile(projectRoot = defaultProjectRoot) {
  const environmentPath = join(projectRoot, ".env");
  if (!isFile(environmentPath) || readFileSync(environmentPath, "utf8").trim().length === 0) {
    throw new Error("Missing or empty .env. Create it from .env.example and fill in the required values before starting.");
  }
  return environmentPath;
}

export function getInstallStep(projectRoot = defaultProjectRoot) {
  if (isFile(join(projectRoot, "package-lock.json"))) {
    return { command: npmExecutable, args: ["ci", "--include=dev"] };
  }
  return { command: npmExecutable, args: ["install", "--include=dev"] };
}

export function findMissingRuntimeDependencies(projectRoot = defaultProjectRoot) {
  const packagePath = join(projectRoot, "package.json");
  if (!isFile(packagePath)) throw new Error(`Missing package.json at ${packagePath}.`);
  const packageData = JSON.parse(readFileSync(packagePath, "utf8"));
  const dependencies = Object.keys(packageData.dependencies ?? {});
  const projectRequire = createRequire(packagePath);
  return dependencies.filter((name) => {
    try {
      projectRequire.resolve(name);
      return false;
    } catch {
      const searchPaths = projectRequire.resolve.paths(name) ?? [];
      return !searchPaths.some((searchPath) => isFile(join(searchPath, name, "package.json")));
    }
  });
}

export function resolveSourceLoader(projectRoot = defaultProjectRoot) {
  const packagePath = join(projectRoot, "package.json");
  if (!isFile(packagePath)) throw new Error(`Missing package.json at ${packagePath}.`);
  try {
    return pathToFileURL(createRequire(packagePath).resolve("tsx")).href;
  } catch {
    throw new Error("The TypeScript fallback requires the local tsx package. Install dependencies and try again.");
  }
}

export function resolveSpawnInvocation(command, args, platform = process.platform, commandShell = process.env.ComSpec) {
  if (platform !== "win32" || !command.toLowerCase().endsWith(".cmd")) return { command, args };
  return {
    command: commandShell || "cmd.exe",
    args: ["/d", "/s", "/c", command, ...args],
  };
}

function runStep(command, args, projectRoot) {
  return new Promise((resolveStep) => {
    const invocation = resolveSpawnInvocation(command, args);
    const child = spawn(invocation.command, invocation.args, {
      cwd: projectRoot,
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });
    activeChild = child;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (activeChild === child) activeChild = undefined;
      resolveStep(result);
    };
    child.once("error", (error) => {
      logError(`[startup] Failed to run ${command}: ${error.message}`);
      finish(false);
    });
    child.once("exit", (code, signal) => {
      finish(code === 0 && signal === null);
    });
  });
}

export async function ensureCompiledEntry(projectRoot = defaultProjectRoot, runner = runStep, dependencyCheck = findMissingRuntimeDependencies) {
  const compiledEntry = join(projectRoot, "dist", "web-server.js");
  if (isFile(compiledEntry)) {
    let missing = dependencyCheck(projectRoot);
    if (missing.length === 0) return compiledEntry;
    log(`[startup] Runtime dependencies are missing (${missing.join(", ")}); installing dependencies.`);
    const install = getInstallStep(projectRoot);
    if (!await runner(install.command, install.args, projectRoot)) {
      throw new Error(`Dependency installation failed; still missing: ${missing.join(", ")}`);
    }
    missing = dependencyCheck(projectRoot);
    if (missing.length > 0) throw new Error(`Dependency installation completed but these packages are still missing: ${missing.join(", ")}`);
    return compiledEntry;
  }

  log("[startup] dist/web-server.js is missing; installing dependencies and building the project.");
  const install = getInstallStep(projectRoot);
  if (!await runner(install.command, install.args, projectRoot)) {
    warn("[startup] Dependency installation failed; falling back to the TypeScript source entrypoint.");
    return undefined;
  }
  if (!await runner(npmExecutable, ["run", "build"], projectRoot)) {
    warn("[startup] Build failed; falling back to the TypeScript source entrypoint.");
    return undefined;
  }
  if (!isFile(compiledEntry)) {
    warn("[startup] Build completed without dist/web-server.js; falling back to the TypeScript source entrypoint.");
    return undefined;
  }
  return compiledEntry;
}

export function createRuntimeEnvironment(environment = process.env) {
  const runtimeEnvironment = { ...environment };
  if (!runtimeEnvironment.PORT && runtimeEnvironment.SERVER_PORT) {
    runtimeEnvironment.PORT = runtimeEnvironment.SERVER_PORT;
  }
  if (!runtimeEnvironment.HOST && (runtimeEnvironment.P_SERVER_UUID || runtimeEnvironment.SERVER_PORT)) {
    runtimeEnvironment.HOST = "0.0.0.0";
  }
  return runtimeEnvironment;
}

function launchServer(command, args, projectRoot) {
  return new Promise((resolveServer, rejectServer) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: createRuntimeEnvironment(),
      stdio: "inherit",
      windowsHide: true,
    });
    activeChild = child;
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      if (activeChild === child) activeChild = undefined;
      callback();
    };
    child.once("error", (error) => {
      finish(() => rejectServer(error));
    });
    child.once("exit", (code, signal) => {
      finish(() => resolveServer(shutdownSignal && signal === shutdownSignal ? 0 : code ?? 1));
    });
  });
}

function installSignalForwarding() {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => {
      shutdownSignal = signal;
      if (activeChild && !activeChild.killed) {
        log(`[startup] Received ${signal}; forwarding it to the active child process.`);
        activeChild.kill(signal);
      }
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
}

function removeSignalForwarding() {
  for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  signalHandlers.clear();
}

export async function main(projectRoot = defaultProjectRoot) {
  removeSignalForwarding();
  shutdownSignal = undefined;
  activeChild = undefined;
  assertEnvironmentFile(projectRoot);
  const majorVersion = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (majorVersion < 20) throw new Error(`Node.js 20 or newer is required; current version is ${process.versions.node}.`);

  process.chdir(projectRoot);
  installSignalForwarding();
  const compiledEntry = await ensureCompiledEntry(projectRoot);
  if (shutdownSignal) return 0;

  if (compiledEntry) {
    removeSignalForwarding();
    log("[startup] Starting compiled MCP Nexus web service.");
    Object.assign(process.env, createRuntimeEnvironment());
    const module = await import(pathToFileURL(compiledEntry).href);
    if (typeof module.runWebServerCli !== "function") throw new Error("Compiled web entrypoint does not export runWebServerCli(). Rebuild the project.");
    await module.runWebServerCli({ projectRoot });
    return 0;
  }

  const sourceEntry = join(projectRoot, "src", "web-server.ts");
  if (!isFile(sourceEntry)) throw new Error("Neither dist/web-server.js nor src/web-server.ts is available.");
  log("[startup] Starting MCP Nexus directly from TypeScript source with tsx.");
  try {
    return await launchServer(process.execPath, ["--import", resolveSourceLoader(projectRoot), sourceEntry], projectRoot);
  } finally {
    removeSignalForwarding();
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === resolve(launcherPath)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      logError(`[startup] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
