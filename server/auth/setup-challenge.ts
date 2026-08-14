import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { SupportDatabase } from "../db/database.js";
import { AuthError } from "./errors.js";

const DEFAULT_TTL_MS = 30 * 60_000;

export interface IssuedSetupChallenge {
  token: string;
  expiresAt: string;
}

export class SetupChallengeService {
  constructor(
    private readonly database: SupportDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  issue(ttlMs = DEFAULT_TTL_MS): IssuedSetupChallenge {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 24 * 60 * 60_000) {
      throw new RangeError("A validade do código deve ficar entre 1 minuto e 24 horas.");
    }
    const token = randomBytes(24).toString("base64url");
    const createdAt = this.now().toISOString();
    const expiresAt = new Date(Date.parse(createdAt) + ttlMs).toISOString();
    this.database
      .prepare(
        `INSERT INTO local_setup_challenges
           (singleton, token_hash, expires_at, used_at, created_at)
         VALUES (1, ?, ?, NULL, ?)
         ON CONFLICT(singleton) DO UPDATE SET
           token_hash = excluded.token_hash,
           expires_at = excluded.expires_at,
           used_at = NULL,
           created_at = excluded.created_at`,
      )
      .run(hash(token), expiresAt, createdAt);
    return { token, expiresAt };
  }

  hasActive(): boolean {
    const row = this.database
      .prepare(
        `SELECT expires_at, used_at FROM local_setup_challenges
         WHERE singleton = 1`,
      )
      .get() as { expires_at: string; used_at: string | null } | undefined;
    return Boolean(row && !row.used_at && row.expires_at > this.now().toISOString());
  }

  assertValid(token: string): void {
    const row = this.database
      .prepare(
        `SELECT token_hash, expires_at, used_at FROM local_setup_challenges
         WHERE singleton = 1`,
      )
      .get() as
      | { token_hash: string; expires_at: string; used_at: string | null }
      | undefined;
    const candidate = Buffer.from(hash(token || ""), "hex");
    const expected = Buffer.from(row?.token_hash ?? hash("invalid"), "hex");
    const matches = timingSafeEqual(candidate, expected);
    if (
      !row ||
      row.used_at ||
      row.expires_at <= this.now().toISOString() ||
      !matches
    ) {
      throw new AuthError(
        "invalid_credentials",
        "O código de configuração é inválido ou expirou.",
      );
    }
  }

  consume(): void {
    const usedAt = this.now().toISOString();
    const result = this.database
      .prepare(
        `UPDATE local_setup_challenges SET used_at = ?
         WHERE singleton = 1 AND used_at IS NULL AND expires_at > ?`,
      )
      .run(usedAt, usedAt);
    if (result.changes !== 1) {
      throw new AuthError(
        "invalid_credentials",
        "O código de configuração é inválido ou expirou.",
      );
    }
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
