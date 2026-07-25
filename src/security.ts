import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
const SESSION_TTL_MS = 12 * 60 * 60 * 1_000;
const MAX_SESSIONS = 32;
const SCRYPT_MAX_MEMORY = 24 * 1024 * 1024;
let scryptQueue: Promise<void> = Promise.resolve();

export interface SecretDigest {
  salt: string;
  hash: string;
}

export interface AuthSession {
  username: string;
  csrfToken: string;
  expiresAt: number;
}

export async function digestSecret(secret: string, salt = randomBytes(16).toString("base64url")): Promise<SecretDigest> {
  const hash = await runScrypt(secret, salt);
  return { salt, hash: hash.toString("base64url") };
}

export async function verifySecret(secret: string, digest: SecretDigest): Promise<boolean> {
  const candidate = await runScrypt(secret, digest.salt);
  const expected = Buffer.from(digest.hash, "base64url");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

async function runScrypt(secret: string, salt: string): Promise<Buffer> {
  const operation = scryptQueue.catch(() => undefined).then(
    () => new Promise<Buffer>((resolve, reject) => {
      scrypt(secret, salt, 64, { maxmem: SCRYPT_MAX_MEMORY }, (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey);
      });
    }),
  );
  scryptQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

export function digestToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

export function verifyToken(token: string, expectedDigest: string): boolean {
  const candidate = Buffer.from(digestToken(token), "base64url");
  const expected = Buffer.from(expectedDigest, "base64url");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

export class SessionManager {
  readonly #sessions = new Map<string, AuthSession>();

  create(username: string): { token: string; session: AuthSession } {
    this.prune();
    if (this.#sessions.size >= MAX_SESSIONS) {
      const oldest = this.#sessions.keys().next().value;
      if (oldest) this.#sessions.delete(oldest);
    }
    const token = generateToken();
    const session = {
      username,
      csrfToken: generateToken(24),
      expiresAt: Date.now() + SESSION_TTL_MS,
    };
    this.#sessions.set(tokenFingerprint(token), session);
    return { token, session };
  }

  get(token: string | undefined): AuthSession | undefined {
    if (!token) return undefined;
    const key = tokenFingerprint(token);
    const session = this.#sessions.get(key);
    if (!session) return undefined;
    if (session.expiresAt <= Date.now()) {
      this.#sessions.delete(key);
      return undefined;
    }
    return session;
  }

  delete(token: string | undefined): void {
    if (token) this.#sessions.delete(tokenFingerprint(token));
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, session] of this.#sessions) {
      if (session.expiresAt <= now) this.#sessions.delete(key);
    }
  }
}

export class LoginGuard {
  readonly #attempts = new Map<string, { failures: number; blockedUntil: number }>();

  isAllowed(key: string): boolean {
    const attempt = this.#attempts.get(key);
    return !attempt || attempt.blockedUntil <= Date.now();
  }

  recordFailure(key: string): void {
    if (!this.#attempts.has(key) && this.#attempts.size >= 1_000) {
      const oldest = this.#attempts.keys().next().value;
      if (oldest) this.#attempts.delete(oldest);
    }
    const previous = this.#attempts.get(key);
    const failures = (previous?.failures ?? 0) + 1;
    const delay = failures < 5 ? 0 : Math.min(60_000, 1_000 * 2 ** (failures - 5));
    this.#attempts.set(key, { failures, blockedUntil: Date.now() + delay });
  }

  clear(key: string): void {
    this.#attempts.delete(key);
  }
}

export function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    if (pair.slice(0, separator).trim() === name) {
      return decodeURIComponent(pair.slice(separator + 1).trim());
    }
  }
  return undefined;
}
