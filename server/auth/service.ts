import { createHash, randomBytes, randomUUID } from "node:crypto";

import type {
  AuthLoginInput,
  AuthRole,
  AuthSessionDto,
  AuthSetupStatusDto,
  AuthUserDto,
  BootstrapAuthSetupInput,
  CreateAuthUserInput,
  UpdateAuthUserInput,
} from "../../shared/contracts.js";
import {
  AUTH_DISPLAY_NAME_MAX_LENGTH,
  AUTH_ORGANIZATION_NAME_MAX_LENGTH,
  AUTH_PASSWORD_MAX_LENGTH,
  AUTH_PASSWORD_MIN_LENGTH,
  AUTH_ROLES,
  AUTH_TIMEZONE_MAX_LENGTH,
  AUTH_USERNAME_MAX_LENGTH,
  AUTH_USERNAME_MIN_LENGTH,
  AUTH_WORKSPACE_NAME_MAX_LENGTH,
} from "../../shared/contracts.js";
import type { SupportDatabase } from "../db/database.js";
import { AuthError } from "./errors.js";
import {
  DUMMY_PASSWORD_HASH,
  hashPassword,
  verifyPassword,
} from "./password.js";

const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_LOCKOUT_THRESHOLD = 5;
const DEFAULT_LOCKOUT_DURATION_MS = 15 * 60 * 1_000;

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  role: AuthRole;
  password_hash: string;
  active: number;
  failed_login_attempts: number;
  locked_until: string | null;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

interface SessionRow extends UserRow {
  session_id: string;
  expires_at: string;
  revoked_at: string | null;
}

export interface AuthenticatedSession extends AuthSessionDto {
  sessionId: string;
}

export interface IssuedAuthSession extends AuthenticatedSession {
  /** Returned once to the caller. Only its SHA-256 digest is persisted. */
  token: string;
}

export interface LocalAuthServiceOptions {
  now?: () => Date;
  sessionTtlMs?: number;
  lockoutThreshold?: number;
  lockoutDurationMs?: number;
}

export class LocalAuthService {
  private readonly now: () => Date;
  private readonly sessionTtlMs: number;
  private readonly lockoutThreshold: number;
  private readonly lockoutDurationMs: number;

  constructor(
    private readonly database: SupportDatabase,
    options: LocalAuthServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.sessionTtlMs = positiveInteger(
      options.sessionTtlMs,
      DEFAULT_SESSION_TTL_MS,
      "sessionTtlMs",
    );
    this.lockoutThreshold = positiveInteger(
      options.lockoutThreshold,
      DEFAULT_LOCKOUT_THRESHOLD,
      "lockoutThreshold",
    );
    this.lockoutDurationMs = positiveInteger(
      options.lockoutDurationMs,
      DEFAULT_LOCKOUT_DURATION_MS,
      "lockoutDurationMs",
    );
  }

  getSetupStatus(): AuthSetupStatusDto {
    const settings = this.database
      .prepare(
        `SELECT organization_name, workspace_name, timezone, setup_completed_at
         FROM local_app_settings
         WHERE singleton = 1`,
      )
      .get() as
      | {
          organization_name: string;
          workspace_name: string;
          timezone: string;
          setup_completed_at: string;
        }
      | undefined;
    const userCount = (
      this.database.prepare("SELECT COUNT(*) AS count FROM local_users").get() as {
        count: number;
      }
    ).count;

    // Requiring both records avoids treating a partially restored database as
    // configured. bootstrapSetup also refuses to overwrite either condition.
    const completed = Boolean(settings) && userCount > 0;
    return {
      required: !completed,
      organizationName: completed ? settings?.organization_name ?? null : null,
      workspaceName: completed ? settings?.workspace_name ?? null : null,
      timezone: completed ? settings?.timezone ?? null : null,
      completedAt: completed ? settings?.setup_completed_at ?? null : null,
    };
  }

  async bootstrapSetup(
    input: BootstrapAuthSetupInput,
  ): Promise<IssuedAuthSession> {
    const organizationName = validateOrganizationName(input.organizationName);
    const workspaceName = validateWorkspaceName(input.workspaceName);
    const timezone = validateTimezone(input.timezone);
    const username = validateUsername(input.username);
    const displayName = validateDisplayName(input.displayName);
    validatePassword(input.password);
    const passwordHash = await hashPassword(input.password);
    const issued = this.prepareSession();
    const now = this.nowIso();
    const userId = randomUUID();

    return this.database.transaction(() => {
      const settingsCount = (
        this.database
          .prepare("SELECT COUNT(*) AS count FROM local_app_settings")
          .get() as { count: number }
      ).count;
      const userCount = (
        this.database.prepare("SELECT COUNT(*) AS count FROM local_users").get() as {
          count: number;
        }
      ).count;
      if (settingsCount > 0 || userCount > 0) {
        throw new AuthError(
          "setup_already_completed",
          "A configuração inicial já foi concluída.",
        );
      }

      this.database
        .prepare(
          `INSERT INTO local_app_settings (
             singleton, organization_name, workspace_name, timezone,
             setup_completed_at, created_at, updated_at
           ) VALUES (1, ?, ?, ?, ?, ?, ?)`,
        )
        .run(organizationName, workspaceName, timezone, now, now, now);
      this.database
        .prepare(
          `INSERT INTO local_users (
             id, username, display_name, role, password_hash, active,
             failed_login_attempts, locked_until, last_login_at,
             password_changed_at, created_at, updated_at
           ) VALUES (?, ?, ?, 'owner', ?, 1, 0, NULL, ?, ?, ?, ?)`,
        )
        .run(userId, username, displayName, passwordHash, now, now, now, now);
      this.insertSession(userId, issued, now);
      this.recordEvent("setup_completed", userId, userId, now, {
        organizationName,
        workspaceName,
        timezone,
      });

      return {
        token: issued.token,
        sessionId: issued.id,
        expiresAt: issued.expiresAt,
        user: this.requireUserById(userId),
      };
    })();
  }

  async login(input: AuthLoginInput): Promise<IssuedAuthSession> {
    const rawUsername = typeof input?.username === "string" ? input.username : "";
    const rawPassword = typeof input?.password === "string" ? input.password : "";
    const normalizedUsername = normalizeUsernameForLookup(rawUsername);
    const candidate = normalizedUsername
      ? this.getUserRowByUsername(normalizedUsername)
      : undefined;
    const passwordHash = candidate?.password_hash ?? DUMMY_PASSWORD_HASH;
    const passwordWithinLimit = rawPassword.length <= AUTH_PASSWORD_MAX_LENGTH;
    const passwordMatches =
      passwordWithinLimit &&
      (await verifyPassword(rawPassword, passwordHash));
    if (!passwordWithinLimit) {
      // Preserve an expensive verification path without feeding an unbounded
      // attacker-controlled value to the KDF.
      await verifyPassword("", DUMMY_PASSWORD_HASH);
    }
    const nowDate = this.now();
    const now = nowDate.toISOString();

    if (!candidate) {
      this.recordEvent("login_failed", null, null, now, {
        identifierHash: identifierHash(normalizedUsername),
      });
      throw invalidCredentials();
    }

    const issued = this.prepareSession(nowDate);
    const result = this.database.transaction(():
      | { kind: "success"; session: IssuedAuthSession }
      | { kind: "invalid" }
      | { kind: "locked"; lockedUntil: string } => {
      const current = this.getUserRowByUsername(normalizedUsername);
      if (
        !current ||
        !current.active ||
        current.id !== candidate.id ||
        current.password_hash !== candidate.password_hash
      ) {
        this.recordEvent("login_failed", current?.id ?? null, null, now, {
          identifierHash: identifierHash(normalizedUsername),
        });
        return { kind: "invalid" };
      }

      const lockedUntil = parseDate(current.locked_until);
      if (lockedUntil && lockedUntil.getTime() > nowDate.getTime()) {
        this.recordEvent("login_failed", current.id, null, now, {
          reason: "locked",
        });
        return { kind: "locked", lockedUntil: lockedUntil.toISOString() };
      }

      if (!passwordMatches) {
        const previousAttempts = lockedUntil ? 0 : current.failed_login_attempts;
        const failedAttempts = previousAttempts + 1;
        const shouldLock = failedAttempts >= this.lockoutThreshold;
        const nextLockedUntil = shouldLock
          ? new Date(nowDate.getTime() + this.lockoutDurationMs).toISOString()
          : null;
        this.database
          .prepare(
            `UPDATE local_users
             SET failed_login_attempts = ?, locked_until = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(failedAttempts, nextLockedUntil, now, current.id);
        this.recordEvent("login_failed", current.id, null, now, {
          failedAttempts,
        });
        if (shouldLock) {
          this.recordEvent("account_locked", current.id, null, now, {
            lockedUntil: nextLockedUntil,
          });
        }
        return { kind: "invalid" };
      }

      this.database
        .prepare(
          `UPDATE local_users
           SET failed_login_attempts = 0, locked_until = NULL,
               last_login_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(now, now, current.id);
      this.insertSession(current.id, issued, now);
      this.recordEvent("login_succeeded", current.id, current.id, now);
      return {
        kind: "success",
        session: {
          token: issued.token,
          sessionId: issued.id,
          expiresAt: issued.expiresAt,
          user: this.requireUserById(current.id),
        },
      };
    })();

    if (result.kind === "success") return result.session;
    if (result.kind === "locked") {
      throw new AuthError("account_locked", "A conta está temporariamente bloqueada.", {
        lockedUntil: result.lockedUntil,
      });
    }
    throw invalidCredentials();
  }

  authenticate(token: string): AuthenticatedSession {
    if (!token) throw authenticationRequired();
    const now = this.nowIso();
    const row = this.getSessionRow(token);
    if (!row || row.revoked_at || !row.active) throw authenticationRequired();
    if (row.expires_at <= now) {
      this.database
        .prepare(
          `UPDATE local_auth_sessions SET revoked_at = ?
           WHERE id = ? AND revoked_at IS NULL`,
        )
        .run(now, row.session_id);
      throw new AuthError("session_expired", "A sessão expirou.");
    }

    this.database
      .prepare("UPDATE local_auth_sessions SET last_seen_at = ? WHERE id = ?")
      .run(now, row.session_id);
    return {
      sessionId: row.session_id,
      expiresAt: row.expires_at,
      user: userDto(row),
    };
  }

  logout(token: string): void {
    if (!token) return;
    const now = this.nowIso();
    const row = this.getSessionRow(token);
    if (!row || row.revoked_at) return;
    this.database.transaction(() => {
      this.database
        .prepare("UPDATE local_auth_sessions SET revoked_at = ? WHERE id = ?")
        .run(now, row.session_id);
      this.recordEvent("logout", row.id, row.id, now, {
        sessionId: row.session_id,
      });
    })();
  }

  listUsers(token: string): AuthUserDto[] {
    const actor = this.authenticate(token).user;
    requireUserManager(actor);
    return (this.database
      .prepare(
        `SELECT id, username, display_name, role, password_hash, active,
                failed_login_attempts, locked_until, last_login_at,
                created_at, updated_at
         FROM local_users
         ORDER BY active DESC, display_name COLLATE NOCASE, id`,
      )
      .all() as UserRow[]).map(userDto);
  }

  async createUser(
    token: string,
    input: CreateAuthUserInput,
  ): Promise<AuthUserDto> {
    const actor = this.authenticate(token).user;
    requireCanManageRole(actor, input.role);
    const username = validateUsername(input.username);
    const displayName = validateDisplayName(input.displayName);
    const role = validateRole(input.role);
    validatePassword(input.password);
    const passwordHash = await hashPassword(input.password);
    const now = this.nowIso();
    const userId = randomUUID();

    try {
      return this.database.transaction(() => {
        // Re-check after the asynchronous KDF so a revoked/deactivated actor
        // cannot complete a pending privileged operation.
        const currentActor = this.authenticate(token).user;
        if (currentActor.id !== actor.id) throw authenticationRequired();
        requireCanManageRole(currentActor, role);
        this.database
          .prepare(
            `INSERT INTO local_users (
               id, username, display_name, role, password_hash, active,
               failed_login_attempts, locked_until, last_login_at,
               password_changed_at, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, 1, 0, NULL, NULL, ?, ?, ?)`,
          )
          .run(userId, username, displayName, role, passwordHash, now, now, now);
        this.recordEvent("user_created", userId, currentActor.id, now, { role });
        return this.requireUserById(userId);
      })();
    } catch (error) {
      throw mapUsernameConstraint(error);
    }
  }

  updateUser(
    token: string,
    userId: string,
    input: UpdateAuthUserInput,
  ): AuthUserDto {
    const actor = this.authenticate(token).user;
    const target = this.requireUserById(userId);
    requireCanUpdateUser(actor, target, input);

    const username =
      input.username === undefined ? target.username : validateUsername(input.username);
    const displayName =
      input.displayName === undefined
        ? target.displayName
        : validateDisplayName(input.displayName);
    const role = input.role === undefined ? target.role : validateRole(input.role);
    const active = input.active === undefined ? target.active : input.active;
    const now = this.nowIso();

    try {
      return this.database.transaction(() => {
        const currentActor = this.requireActiveUserById(actor.id);
        const currentTarget = this.requireUserById(userId);
        requireCanUpdateUser(currentActor, currentTarget, input);
        this.protectLastOwner(currentTarget, role, active);
        this.database
          .prepare(
            `UPDATE local_users
             SET username = ?, display_name = ?, role = ?, active = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(username, displayName, role, active ? 1 : 0, now, userId);
        if (!active) this.revokeUserSessions(userId, currentActor.id, now);
        this.recordEvent("user_updated", userId, currentActor.id, now, {
          role,
          active,
        });
        return this.requireUserById(userId);
      })();
    } catch (error) {
      throw mapUsernameConstraint(error);
    }
  }

  deleteUser(token: string, userId: string): void {
    const actor = this.authenticate(token).user;
    const target = this.requireUserById(userId);
    requireCanDeleteUser(actor, target);
    const now = this.nowIso();

    this.database.transaction(() => {
      const currentActor = this.requireActiveUserById(actor.id);
      const currentTarget = this.requireUserById(userId);
      requireCanDeleteUser(currentActor, currentTarget);
      this.protectLastOwner(currentTarget, currentTarget.role, false);
      this.recordEvent("user_deleted", userId, currentActor.id, now, {
        role: currentTarget.role,
      });
      this.database.prepare("DELETE FROM local_users WHERE id = ?").run(userId);
    })();
  }

  async changeOwnPassword(
    token: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<IssuedAuthSession> {
    const session = this.authenticate(token);
    validatePassword(newPassword);
    const row = this.requireUserRowById(session.user.id);
    const currentMatches = await verifyPassword(currentPassword, row.password_hash);
    if (!currentMatches) throw invalidCredentials();
    const passwordHash = await hashPassword(newPassword);
    const nowDate = this.now();
    const now = nowDate.toISOString();
    const issued = this.prepareSession(nowDate);

    return this.database.transaction(() => {
      const currentUser = this.authenticate(token).user;
      const currentRow = this.requireUserRowById(currentUser.id);
      if (
        currentUser.id !== session.user.id ||
        currentRow.password_hash !== row.password_hash
      ) {
        throw authenticationRequired();
      }
      this.database
        .prepare(
          `UPDATE local_users
           SET password_hash = ?, password_changed_at = ?,
               failed_login_attempts = 0, locked_until = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(passwordHash, now, now, currentUser.id);
      this.revokeUserSessions(currentUser.id, currentUser.id, now);
      this.insertSession(currentUser.id, issued, now);
      this.recordEvent("password_changed", currentUser.id, currentUser.id, now);
      return {
        token: issued.token,
        sessionId: issued.id,
        expiresAt: issued.expiresAt,
        user: this.requireUserById(currentUser.id),
      };
    })();
  }

  async resetUserPassword(
    token: string,
    userId: string,
    newPassword: string,
  ): Promise<void> {
    const actor = this.authenticate(token).user;
    const target = this.requireUserById(userId);
    if (actor.id === target.id) {
      throw new AuthError(
        "forbidden",
        "Use a troca de senha da própria conta.",
      );
    }
    requireCanManageExistingUser(actor, target);
    validatePassword(newPassword);
    const passwordHash = await hashPassword(newPassword);
    const now = this.nowIso();

    this.database.transaction(() => {
      const currentActor = this.authenticate(token).user;
      if (currentActor.id !== actor.id) throw authenticationRequired();
      const currentTarget = this.requireUserById(userId);
      requireCanManageExistingUser(currentActor, currentTarget);
      this.database
        .prepare(
          `UPDATE local_users
           SET password_hash = ?, password_changed_at = ?,
               failed_login_attempts = 0, locked_until = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(passwordHash, now, now, userId);
      this.revokeUserSessions(userId, currentActor.id, now);
      this.recordEvent("password_changed", userId, currentActor.id, now);
    })();
  }

  revokeAllSessions(token: string): void {
    const actor = this.authenticate(token).user;
    this.revokeUserSessions(actor.id, actor.id, this.nowIso());
  }

  private protectLastOwner(
    target: AuthUserDto,
    nextRole: AuthRole,
    nextActive: boolean,
  ): void {
    if (!target.active || target.role !== "owner") return;
    if (nextActive && nextRole === "owner") return;
    const remainingOwners = (
      this.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM local_users
           WHERE role = 'owner' AND active = 1 AND id != ?`,
        )
        .get(target.id) as { count: number }
    ).count;
    if (remainingOwners === 0) {
      throw new AuthError(
        "last_owner_protected",
        "O último proprietário ativo não pode ser removido ou rebaixado.",
      );
    }
  }

  private requireActiveUserById(userId: string): AuthUserDto {
    const user = this.requireUserById(userId);
    if (!user.active) throw authenticationRequired();
    return user;
  }

  private requireUserById(userId: string): AuthUserDto {
    return userDto(this.requireUserRowById(userId));
  }

  private requireUserRowById(userId: string): UserRow {
    const row = this.database
      .prepare(
        `SELECT id, username, display_name, role, password_hash, active,
                failed_login_attempts, locked_until, last_login_at,
                created_at, updated_at
         FROM local_users WHERE id = ?`,
      )
      .get(userId) as UserRow | undefined;
    if (!row) throw new AuthError("user_not_found", "Usuário não encontrado.");
    return row;
  }

  private getUserRowByUsername(username: string): UserRow | undefined {
    return this.database
      .prepare(
        `SELECT id, username, display_name, role, password_hash, active,
                failed_login_attempts, locked_until, last_login_at,
                created_at, updated_at
         FROM local_users WHERE username = ? COLLATE NOCASE`,
      )
      .get(username) as UserRow | undefined;
  }

  private getSessionRow(token: string): SessionRow | undefined {
    return this.database
      .prepare(
        `SELECT session.id AS session_id, session.expires_at,
                session.revoked_at,
                user.id, user.username, user.display_name, user.role,
                user.password_hash, user.active, user.failed_login_attempts,
                user.locked_until, user.last_login_at,
                user.created_at, user.updated_at
         FROM local_auth_sessions session
         JOIN local_users user ON user.id = session.user_id
         WHERE session.token_hash = ?`,
      )
      .get(hashSessionToken(token)) as SessionRow | undefined;
  }

  private prepareSession(now = this.now()): {
    id: string;
    token: string;
    tokenHash: string;
    expiresAt: string;
  } {
    const token = randomBytes(32).toString("base64url");
    return {
      id: randomUUID(),
      token,
      tokenHash: hashSessionToken(token),
      expiresAt: new Date(now.getTime() + this.sessionTtlMs).toISOString(),
    };
  }

  private insertSession(
    userId: string,
    issued: { id: string; tokenHash: string; expiresAt: string },
    now: string,
  ): void {
    this.database
      .prepare(
        `INSERT INTO local_auth_sessions (
           id, user_id, token_hash, expires_at, last_seen_at, revoked_at, created_at
         ) VALUES (?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(issued.id, userId, issued.tokenHash, issued.expiresAt, now, now);
  }

  private revokeUserSessions(userId: string, actorUserId: string, now: string): void {
    const sessions = this.database
      .prepare(
        `SELECT id FROM local_auth_sessions
         WHERE user_id = ? AND revoked_at IS NULL`,
      )
      .all(userId) as Array<{ id: string }>;
    this.database
      .prepare(
        `UPDATE local_auth_sessions SET revoked_at = ?
         WHERE user_id = ? AND revoked_at IS NULL`,
      )
      .run(now, userId);
    for (const session of sessions) {
      this.recordEvent("session_revoked", userId, actorUserId, now, {
        sessionId: session.id,
      });
    }
  }

  private recordEvent(
    eventType:
      | "setup_completed"
      | "login_succeeded"
      | "login_failed"
      | "account_locked"
      | "logout"
      | "session_revoked"
      | "user_created"
      | "user_updated"
      | "user_deleted"
      | "password_changed",
    userId: string | null,
    actorUserId: string | null,
    occurredAt: string,
    data: Readonly<Record<string, unknown>> = {},
  ): void {
    this.database
      .prepare(
        `INSERT INTO local_auth_events (
           id, user_id, event_type, actor_user_id, data_json, occurred_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        userId,
        eventType,
        actorUserId,
        JSON.stringify(data),
        occurredAt,
      );
  }

  private nowIso(): string {
    return this.now().toISOString();
  }
}

function validateUsername(value: string): string {
  if (typeof value !== "string") {
    throw new AuthError("invalid_input", "Nome de usuário inválido.");
  }
  const username = normalizeUsernameForLookup(value);
  if (
    username.length < AUTH_USERNAME_MIN_LENGTH ||
    username.length > AUTH_USERNAME_MAX_LENGTH ||
    !/^[a-z0-9][a-z0-9._-]*$/.test(username)
  ) {
    throw new AuthError(
      "invalid_input",
      `O usuário deve ter entre ${AUTH_USERNAME_MIN_LENGTH} e ${AUTH_USERNAME_MAX_LENGTH} caracteres e usar apenas letras minúsculas, números, ponto, hífen ou sublinhado.`,
    );
  }
  return username;
}

function normalizeUsernameForLookup(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

function validateDisplayName(value: string): string {
  return boundedText(value, AUTH_DISPLAY_NAME_MAX_LENGTH, "nome");
}

function validateOrganizationName(value: string): string {
  return boundedText(value, AUTH_ORGANIZATION_NAME_MAX_LENGTH, "organização");
}

function validateWorkspaceName(value: string): string {
  return boundedText(value, AUTH_WORKSPACE_NAME_MAX_LENGTH, "workspace");
}

function validateTimezone(value: string): string {
  const timezone = boundedText(value, AUTH_TIMEZONE_MAX_LENGTH, "fuso horário");
  try {
    new Intl.DateTimeFormat("pt-BR", { timeZone: timezone }).format();
  } catch {
    throw new AuthError("invalid_input", "Fuso horário inválido.");
  }
  return timezone;
}

function boundedText(value: string, maximum: number, label: string): string {
  if (typeof value !== "string") {
    throw new AuthError("invalid_input", `O ${label} é obrigatório.`);
  }
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > maximum) {
    throw new AuthError(
      "invalid_input",
      `O ${label} deve ter entre 1 e ${maximum} caracteres.`,
    );
  }
  return normalized;
}

function validatePassword(value: string): void {
  if (
    typeof value !== "string" ||
    value.length < AUTH_PASSWORD_MIN_LENGTH ||
    value.length > AUTH_PASSWORD_MAX_LENGTH
  ) {
    throw new AuthError(
      "invalid_input",
      `A senha deve ter entre ${AUTH_PASSWORD_MIN_LENGTH} e ${AUTH_PASSWORD_MAX_LENGTH} caracteres.`,
    );
  }
}

function validateRole(role: AuthRole): AuthRole {
  if (typeof role !== "string" || !(AUTH_ROLES as readonly string[]).includes(role)) {
    throw new AuthError("invalid_input", "Perfil de acesso inválido.");
  }
  return role;
}

function requireUserManager(actor: AuthUserDto): void {
  if (actor.role !== "owner" && actor.role !== "admin") forbidden();
}

function requireCanManageRole(actor: AuthUserDto, role: AuthRole): void {
  requireUserManager(actor);
  if (actor.role === "admin" && (role === "owner" || role === "admin")) forbidden();
}

function requireCanManageExistingUser(
  actor: AuthUserDto,
  target: AuthUserDto,
): void {
  requireUserManager(actor);
  if (
    actor.role === "admin" &&
    (target.role === "owner" || target.role === "admin")
  ) {
    forbidden();
  }
}

function requireCanUpdateUser(
  actor: AuthUserDto,
  target: AuthUserDto,
  input: UpdateAuthUserInput,
): void {
  if (actor.id === target.id) {
    if (input.role !== undefined || input.active !== undefined) forbidden();
    return;
  }
  requireCanManageExistingUser(actor, target);
  if (input.role !== undefined) requireCanManageRole(actor, input.role);
}

function requireCanDeleteUser(actor: AuthUserDto, target: AuthUserDto): void {
  if (actor.id === target.id && actor.role !== "owner") forbidden();
  requireCanManageExistingUser(actor, target);
}

function forbidden(): never {
  throw new AuthError("forbidden", "Você não tem permissão para esta ação.");
}

function authenticationRequired(): AuthError {
  return new AuthError("authentication_required", "Autenticação necessária.");
}

function invalidCredentials(): AuthError {
  return new AuthError("invalid_credentials", "Usuário ou senha inválidos.");
}

function userDto(row: UserRow): AuthUserDto {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    active: Boolean(row.active),
    lockedUntil: row.locked_until,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function identifierHash(username: string): string {
  return createHash("sha256").update(username, "utf8").digest("hex");
}

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return value;
}

function mapUsernameConstraint(error: unknown): unknown {
  if (
    error instanceof Error &&
    /UNIQUE constraint failed: local_users\.username/i.test(error.message)
  ) {
    return new AuthError("username_taken", "Este nome de usuário já está em uso.");
  }
  return error;
}
