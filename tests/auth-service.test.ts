import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { afterEach } from "node:test";

import { AuthError, LocalAuthService } from "../server/auth/index.js";
import { createDatabase, type SupportDatabase } from "../server/db/database.js";

const databases: SupportDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function fixture(options: ConstructorParameters<typeof LocalAuthService>[1] = {}) {
  const database = createDatabase(":memory:");
  databases.push(database);
  return { database, auth: new LocalAuthService(database, options) };
}

async function bootstrap(auth: LocalAuthService) {
  return auth.bootstrapSetup({
    organizationName: "Acme Comércio",
    workspaceName: "Suporte",
    timezone: "America/Sao_Paulo",
    username: "owner",
    displayName: "Pessoa proprietária",
    password: "correct horse battery staple",
  });
}

function expectAuthCode(code: AuthError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof AuthError && error.code === code;
}

test("migração 17 cria autenticação local sem alterar dados operacionais", () => {
  const { database, auth } = fixture();
  database
    .prepare(
      `INSERT INTO categories (
         id, facet, slug, label, color, created_at, updated_at
       ) VALUES ('existing', 'reason', 'existing', 'Existente', NULL, ?, ?)`,
    )
    .run("2026-07-18T12:00:00.000Z", "2026-07-18T12:00:00.000Z");

  const migration = database
    .prepare("SELECT name FROM schema_migrations WHERE version = 17")
    .get() as { name: string };
  assert.equal(migration.name, "local_application_authentication");
  assert.equal(auth.getSetupStatus().required, true);
  assert.equal(
    (
      database.prepare("SELECT COUNT(*) AS count FROM categories").get() as {
        count: number;
      }
    ).count,
    1,
  );
});

test("bootstrap é atômico, cria owner e nunca persiste senha ou token em claro", async () => {
  const { database, auth } = fixture({
    now: () => new Date("2026-07-18T12:00:00.000Z"),
  });
  const issued = await bootstrap(auth);

  assert.equal(issued.user.role, "owner");
  assert.equal(issued.user.username, "owner");
  assert.equal(auth.getSetupStatus().required, false);
  assert.deepEqual(auth.getSetupStatus(), {
    required: false,
    organizationName: "Acme Comércio",
    workspaceName: "Suporte",
    timezone: "America/Sao_Paulo",
    completedAt: "2026-07-18T12:00:00.000Z",
  });

  const storedUser = database
    .prepare("SELECT password_hash FROM local_users WHERE id = ?")
    .get(issued.user.id) as { password_hash: string };
  assert.match(storedUser.password_hash, /^\$scrypt\$/);
  assert.doesNotMatch(storedUser.password_hash, /correct horse battery staple/);

  const storedSession = database
    .prepare("SELECT token_hash FROM local_auth_sessions WHERE id = ?")
    .get(issued.sessionId) as { token_hash: string };
  assert.notEqual(storedSession.token_hash, issued.token);
  assert.equal(
    storedSession.token_hash,
    createHash("sha256").update(issued.token).digest("hex"),
  );

  await assert.rejects(
    auth.bootstrapSetup({
      organizationName: "Outra",
      workspaceName: "Outro",
      timezone: "UTC",
      username: "other",
      displayName: "Outra pessoa",
      password: "another secure password",
    }),
    expectAuthCode("setup_already_completed"),
  );
  assert.equal(
    (
      database.prepare("SELECT COUNT(*) AS count FROM local_users").get() as {
        count: number;
      }
    ).count,
    1,
  );
});

test("setup valida política de senha, identificador e timezone", async () => {
  const { auth } = fixture();
  await assert.rejects(
    auth.bootstrapSetup({
      organizationName: "Acme",
      workspaceName: "Suporte",
      timezone: "fuso/inexistente",
      username: "Owner Inválido",
      displayName: "Owner",
      password: "curta",
    }),
    expectAuthCode("invalid_input"),
  );
  assert.equal(auth.getSetupStatus().required, true);
});

test("login bloqueia temporariamente após tentativas inválidas e recupera depois", async () => {
  let currentTime = new Date("2026-07-18T12:00:00.000Z");
  const { database, auth } = fixture({
    now: () => currentTime,
    lockoutThreshold: 3,
    lockoutDurationMs: 60_000,
  });
  await bootstrap(auth);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(
      auth.login({ username: "OWNER", password: "senha incorreta" }),
      expectAuthCode("invalid_credentials"),
    );
  }
  const locked = database
    .prepare(
      "SELECT failed_login_attempts, locked_until FROM local_users WHERE username = 'owner'",
    )
    .get() as { failed_login_attempts: number; locked_until: string | null };
  assert.equal(locked.failed_login_attempts, 3);
  assert.equal(locked.locked_until, "2026-07-18T12:01:00.000Z");

  await assert.rejects(
    auth.login({ username: "owner", password: "correct horse battery staple" }),
    expectAuthCode("account_locked"),
  );

  currentTime = new Date("2026-07-18T12:01:01.000Z");
  const session = await auth.login({
    username: "owner",
    password: "correct horse battery staple",
  });
  assert.equal(session.user.lockedUntil, null);
  assert.equal(auth.authenticate(session.token).user.id, session.user.id);
});

test("sessões opacas expiram e logout as revoga", async () => {
  let currentTime = new Date("2026-07-18T12:00:00.000Z");
  const { database, auth } = fixture({
    now: () => currentTime,
    sessionTtlMs: 1_000,
  });
  const first = await bootstrap(auth);
  auth.logout(first.token);
  assert.throws(() => auth.authenticate(first.token), expectAuthCode("authentication_required"));

  const second = await auth.login({
    username: "owner",
    password: "correct horse battery staple",
  });
  currentTime = new Date("2026-07-18T12:00:02.000Z");
  assert.throws(() => auth.authenticate(second.token), expectAuthCode("session_expired"));
  assert.ok(
    (
      database
        .prepare("SELECT revoked_at FROM local_auth_sessions WHERE id = ?")
        .get(second.sessionId) as { revoked_at: string | null }
    ).revoked_at,
  );
});

test("admin gerencia somente operadores e visualizadores", async () => {
  const { auth } = fixture();
  const owner = await bootstrap(auth);
  const admin = await auth.createUser(owner.token, {
    username: "admin",
    displayName: "Admin",
    role: "admin",
    password: "admin password is secure",
  });
  const operator = await auth.createUser(owner.token, {
    username: "operator",
    displayName: "Operador",
    role: "operator",
    password: "operator password secure",
  });
  const adminSession = await auth.login({
    username: admin.username,
    password: "admin password is secure",
  });

  const viewer = await auth.createUser(adminSession.token, {
    username: "viewer",
    displayName: "Visualizador",
    role: "viewer",
    password: "viewer password is secure",
  });
  assert.equal(viewer.role, "viewer");
  assert.equal(auth.listUsers(adminSession.token).length, 4);
  await assert.rejects(
    auth.createUser(adminSession.token, {
      username: "second-admin",
      displayName: "Segundo admin",
      role: "admin",
      password: "second admin secure password",
    }),
    expectAuthCode("forbidden"),
  );
  assert.throws(
    () => auth.updateUser(adminSession.token, operator.id, { role: "admin" }),
    expectAuthCode("forbidden"),
  );
  assert.throws(
    () => auth.updateUser(adminSession.token, owner.user.id, { displayName: "Mudado" }),
    expectAuthCode("forbidden"),
  );
});

test("último owner ativo é protegido e a própria conta não altera seu papel", async () => {
  const { auth } = fixture();
  const owner = await bootstrap(auth);

  assert.throws(
    () => auth.deleteUser(owner.token, owner.user.id),
    expectAuthCode("last_owner_protected"),
  );

  const secondOwner = await auth.createUser(owner.token, {
    username: "owner-two",
    displayName: "Segundo owner",
    role: "owner",
    password: "second owner secure password",
  });
  const demoted = auth.updateUser(owner.token, secondOwner.id, { role: "admin" });
  assert.equal(demoted.role, "admin");
  assert.throws(
    () => auth.updateUser(owner.token, owner.user.id, { active: false }),
    expectAuthCode("forbidden"),
  );
});

test("troca de senha própria revoga sessões anteriores e emite outra sessão", async () => {
  const { auth } = fixture();
  const owner = await bootstrap(auth);
  const oldExtraSession = await auth.login({
    username: "owner",
    password: "correct horse battery staple",
  });
  const next = await auth.changeOwnPassword(
    owner.token,
    "correct horse battery staple",
    "a newer and safer password",
  );

  assert.throws(
    () => auth.authenticate(owner.token),
    expectAuthCode("authentication_required"),
  );
  assert.throws(
    () => auth.authenticate(oldExtraSession.token),
    expectAuthCode("authentication_required"),
  );
  assert.equal(auth.authenticate(next.token).user.id, owner.user.id);
  await assert.rejects(
    auth.login({
      username: "owner",
      password: "correct horse battery staple",
    }),
    expectAuthCode("invalid_credentials"),
  );
});
