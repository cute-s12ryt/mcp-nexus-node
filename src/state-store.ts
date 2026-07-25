import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { appStateSchema, defaultAppState, type AppState } from "./app-state.js";

export interface StateStore {
  read(): Promise<AppState>;
  update(mutator: (state: AppState) => void): Promise<AppState>;
}

export class JsonStateStore implements StateStore {
  readonly #filePath: string;
  #snapshot: AppState | undefined;
  #loadPromise: Promise<AppState> | undefined;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.#filePath = filePath;
  }

  async read(): Promise<AppState> {
    return structuredClone(await this.#load());
  }

  async #load(): Promise<AppState> {
    if (this.#snapshot) return this.#snapshot;
    this.#loadPromise ??= this.#readFromDisk().then((state) => {
      this.#snapshot = state;
      return state;
    }).finally(() => {
      this.#loadPromise = undefined;
    });
    return this.#loadPromise;
  }

  async #readFromDisk(): Promise<AppState> {
    try {
      const contents = await readFile(this.#filePath, "utf8");
      return appStateSchema.parse(JSON.parse(contents));
    } catch (error) {
      if (isMissingFile(error)) {
        return defaultAppState();
      }
      throw error;
    }
  }

  async update(mutator: (state: AppState) => void): Promise<AppState> {
    let result = defaultAppState();
    const operation = this.#writeQueue.catch(() => undefined).then(async () => {
      const next = structuredClone(await this.#load());
      mutator(next);
      result = appStateSchema.parse(next);
      await mkdir(dirname(this.#filePath), { recursive: true });
      const temporaryPath = `${this.#filePath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(result, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporaryPath, this.#filePath);
      this.#snapshot = result;
    });
    this.#writeQueue = operation;
    await operation;
    return structuredClone(result);
  }
}

export class InMemoryStateStore implements StateStore {
  #state: AppState;

  constructor(initialState: AppState = defaultAppState()) {
    this.#state = appStateSchema.parse(structuredClone(initialState));
  }

  async read(): Promise<AppState> {
    return structuredClone(this.#state);
  }

  async update(mutator: (state: AppState) => void): Promise<AppState> {
    const next = structuredClone(this.#state);
    mutator(next);
    this.#state = appStateSchema.parse(next);
    return this.read();
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
