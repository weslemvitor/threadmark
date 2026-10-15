import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { SupportDatabase } from "../db/database.js";
import { AuthError } from "./errors.js";

export interface IntegrationCredentialDto {
  id: string;
  userId: string;
  name: string;
  scope: "headless";
  clientId: "threadmark-cli";
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IssuedIntegrationCredential {
  credential: IntegrationCredentialDto;
  token: string;
}

export interface IntegrationCredentialServiceOptions {
  now?: () => Date;
}

interface IntegrationCredentialRow {
  id: string;
  user_id: string;
  name: string;
  scope: "headless";
  client_id: "hermes" | "threadmark-cli";
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

export class IntegrationCredentialService {
  private readonly now: () => Date;

  constructor(
    private readonly database: SupportDatabase,
    options: IntegrationCredentialServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  create(
    userId: string,
    input: {
      name: string;
      clientId?: string;
      expiresAt: string | null;
    },
  ): IssuedIntegrationCredential {
    const normalizedUserId = requiredValue(userId, "Usuário inválido.", 200);
    this.requireActiveUser(normalizedUserId);
    const name = requiredValue(input.name, "Informe um nome para a credencial.", 100);
    const nowDate = this.now();
    const expiresAt = futureExpirationDate(input.expiresAt, nowDate);
    const token = `tmk_${randomBytes(32).toString("base64url")}`;
    const now = nowDate.toISOString();
    const id = randomUUID();

    this.database
      .prepare(
        `INSERT INTO integration_credentials (
           id, user_id, name, token_digest, scope, client_id, expires_at,
           last_used_at, revoked_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'headless', ?, ?, NULL, NULL, ?, ?)`,
      )
      .run(id, normalizedUserId, name, digest(token), "threadmark-cli", expiresAt, now, now);

    return {
      credential: this.requireCredential(normalizedUserId, id),
      token,
    };
  }

  list(userId: string): IntegrationCredentialDto[] {
    if (!userId.trim()) return [];
    return (this.database
      .prepare(
        `SELECT id, user_id, name, scope, client_id, expires_at, last_used_at,
                revoked_at, created_at, updated_at
         FROM integration_credentials
         WHERE user_id = ?
         ORDER BY revoked_at IS NOT NULL, created_at DESC, id`,
      )
      .all(userId.trim()) as IntegrationCredentialRow[]).map(credentialDto);
  }

  authenticate(token: string): IntegrationCredentialDto {
    const normalized = token.trim();
    if (!normalized.startsWith("tmk_") || normalized.length < 40) {
      throw invalidCredential();
    }
    const row = this.database
      .prepare(
        `SELECT credential.id, credential.user_id, credential.name,
                credential.scope, credential.client_id, credential.expires_at, credential.last_used_at,
                credential.revoked_at, credential.created_at, credential.updated_at
         FROM integration_credentials credential
         INNER JOIN local_users user ON user.id = credential.user_id
         WHERE credential.token_digest = ? AND user.active = 1`,
      )
      .get(digest(normalized)) as IntegrationCredentialRow | undefined;
    if (!row || row.revoked_at || !row.expires_at) throw invalidCredential();

    const now = this.now().toISOString();
    if (row.expires_at && row.expires_at <= now) {
      throw new AuthError("invalid_credentials", "Credencial de integração expirada.");
    }
    this.database
      .prepare(
        "UPDATE integration_credentials SET last_used_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(now, now, row.id);
    return { ...credentialDto(row), lastUsedAt: now, updatedAt: now };
  }

  revoke(userId: string, credentialId: string): IntegrationCredentialDto {
    const normalizedUserId = requiredValue(userId, "Usuário inválido.", 200);
    const normalizedCredentialId = requiredValue(
      credentialId,
      "Credencial inválida.",
      200,
    );
    const current = this.database
      .prepare(
        `SELECT id, user_id, name, scope, client_id, expires_at, last_used_at,
                revoked_at, created_at, updated_at
         FROM integration_credentials
         WHERE id = ? AND user_id = ?`,
      )
      .get(normalizedCredentialId, normalizedUserId) as IntegrationCredentialRow | undefined;
    if (!current) {
      throw new AuthError("invalid_input", "Credencial de integração não encontrada.");
    }
    if (!current.revoked_at) {
      const now = this.now().toISOString();
      this.database
        .prepare(
          "UPDATE integration_credentials SET revoked_at = ?, updated_at = ? WHERE id = ?",
        )
        .run(now, now, current.id);
    }
    return this.requireCredential(normalizedUserId, normalizedCredentialId);
  }

  private requireCredential(userId: string, credentialId: string): IntegrationCredentialDto {
    const row = this.database
      .prepare(
        `SELECT id, user_id, name, scope, client_id, expires_at, last_used_at,
                revoked_at, created_at, updated_at
         FROM integration_credentials
         WHERE id = ? AND user_id = ?`,
      )
      .get(credentialId, userId) as IntegrationCredentialRow | undefined;
    if (!row) {
      throw new AuthError("invalid_input", "Credencial de integração não encontrada.");
    }
    return credentialDto(row);
  }

  private requireActiveUser(userId: string): void {
    const row = this.database
      .prepare("SELECT 1 AS found FROM local_users WHERE id = ? AND active = 1")
      .get(userId) as { found: number } | undefined;
    if (!row) throw new AuthError("user_not_found", "Usuário ativo não encontrado.");
  }
}

function credentialDto(row: IntegrationCredentialRow): IntegrationCredentialDto {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    scope: row.scope,
    clientId: "threadmark-cli",
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function requiredValue(value: string, message: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new AuthError("invalid_input", message);
  }
  return normalized;
}

function futureExpirationDate(value: string | null, now: Date): string {
  if (value === null) {
    throw new AuthError("invalid_input", "Informe a expiração da credencial.");
  }
  const normalized = value.trim();
  if (!normalized || Number.isNaN(Date.parse(normalized))) {
    throw new AuthError("invalid_input", "Expiração da credencial inválida.");
  }
  const expiration = new Date(normalized);
  if (expiration.getTime() <= now.getTime()) {
    throw new AuthError("invalid_input", "A expiração da credencial deve ser futura.");
  }
  return expiration.toISOString();
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function invalidCredential(): AuthError {
  return new AuthError("invalid_credentials", "Credencial de integração inválida ou revogada.");
}
