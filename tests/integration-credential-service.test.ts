import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import {
  IntegrationCredentialService,
  LocalAuthService,
} from "../server/auth/index.js";
import { createDatabase, type SupportDatabase } from "../server/db/database.js";

const databases: SupportDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

async function fixture(now = new Date("2026-09-24T15:00:00.000Z")) {
  const database = createDatabase(":memory:");
  databases.push(database);
  const auth = new LocalAuthService(database, { now: () => now });
  const setup = await auth.bootstrapSetup({
    organizationName: "Acme",
    workspaceName: "Suporte",
    username: "weslem",
    displayName: "Weslem",
    password: "senha-segura-123",
    timezone: "America/Sao_Paulo",
  });
  return {
    database,
    auth,
    sessionToken: setup.token,
    user: setup.user,
    credentials: new IntegrationCredentialService(database, { now: () => now }),
  };
}

test("credencial de integração guarda somente o hash e autentica o usuário vinculado", async () => {
  const { database, user, credentials } = await fixture();

  const issued = credentials.create(user.id, {
    name: "Hermes no Mac",
    clientId: "hermes",
    expiresAt: "2026-12-24T15:00:00.000Z",
  });

  assert.match(issued.token, /^tmk_[A-Za-z0-9_-]{43}$/);
  assert.equal(issued.credential.userId, user.id);
  assert.equal(issued.credential.name, "Hermes no Mac");
  assert.equal(issued.credential.revokedAt, null);
  assert.equal(issued.credential.lastUsedAt, null);

  const stored = database
    .prepare("SELECT token_digest FROM integration_credentials WHERE id = ?")
    .get(issued.credential.id) as { token_digest: string };
  assert.notEqual(stored.token_digest, issued.token);
  assert.equal(JSON.stringify(credentials.list(user.id)).includes(issued.token), false);

  const authenticated = credentials.authenticate(issued.token);
  assert.equal(authenticated.userId, user.id);
  assert.equal(authenticated.id, issued.credential.id);
  assert.equal(credentials.list(user.id)[0]?.lastUsedAt, "2026-09-24T15:00:00.000Z");
});

test("credencial revogada ou expirada deixa de autenticar", async () => {
  const { database, user, credentials } = await fixture();
  const active = credentials.create(user.id, {
    name: "Hermes",
    clientId: "hermes",
    expiresAt: "2026-12-24T15:00:00.000Z",
  });
  const expired = credentials.create(user.id, {
    name: "CLI antiga",
    clientId: "hermes",
    expiresAt: "2026-12-24T15:00:00.000Z",
  });
  database
    .prepare("UPDATE integration_credentials SET expires_at = ? WHERE id = ?")
    .run("2026-09-24T14:59:59.000Z", expired.credential.id);

  credentials.revoke(user.id, active.credential.id);

  assert.throws(() => credentials.authenticate(active.token), /revogada|inválida/i);
  assert.throws(() => credentials.authenticate(expired.token), /expirada|inválida/i);
  assert.ok(credentials.list(user.id).find((item) => item.id === active.credential.id)?.revokedAt);
});

test("credenciais novas e antigas usam a mesma identidade CLI sem renovar o token", async () => {
  const { database, user, credentials } = await fixture();
  const issued = credentials.create(user.id, {
    name: "CLI",
    expiresAt: "2026-12-24T15:00:00.000Z",
  });
  assert.equal(issued.credential.clientId, "threadmark-cli");

  database.prepare("UPDATE integration_credentials SET client_id = 'hermes' WHERE id = ?")
    .run(issued.credential.id);
  assert.equal(credentials.authenticate(issued.token).clientId, "threadmark-cli");
  assert.equal(credentials.list(user.id)[0]?.clientId, "threadmark-cli");

  const legacyRequest = credentials.create(user.id, {
    name: "Cliente antigo",
    clientId: "hermes",
    expiresAt: "2026-12-24T15:00:00.000Z",
  });
  assert.equal(legacyRequest.credential.clientId, "threadmark-cli");
});

test("um usuário não pode listar nem revogar credenciais de outro usuário", async () => {
  const { user, credentials } = await fixture();
  const issued = credentials.create(user.id, {
    name: "Hermes",
    clientId: "hermes",
    expiresAt: "2026-12-24T15:00:00.000Z",
  });

  assert.deepEqual(credentials.list("outro-usuario"), []);
  assert.throws(
    () => credentials.revoke("outro-usuario", issued.credential.id),
    /não encontrada/i,
  );
  assert.equal(credentials.authenticate(issued.token).userId, user.id);
});

test("credenciais exigem expiração futura", async () => {
  const { user, credentials } = await fixture();
  assert.throws(
    () => credentials.create(user.id, {
      name: "Sem prazo",
      clientId: "hermes",
      expiresAt: null,
    }),
    /expiração/i,
  );
  assert.throws(
    () => credentials.create(user.id, {
      name: "Expirada",
      clientId: "hermes",
      expiresAt: "2026-09-24T14:59:59.000Z",
    }),
    /futura/i,
  );
});

test("desativar usuário revoga suas credenciais mesmo após reativação", async () => {
  const { auth, sessionToken, credentials } = await fixture();
  const operator = await auth.createUser(sessionToken, {
    username: "operador",
    displayName: "Operador",
    role: "operator",
    password: "senha segura do operador",
  });
  const issued = credentials.create(operator.id, {
    name: "Hermes",
    clientId: "hermes",
    expiresAt: "2026-12-24T15:00:00.000Z",
  });

  auth.updateUser(sessionToken, operator.id, { active: false });
  auth.updateUser(sessionToken, operator.id, { active: true });

  assert.throws(() => credentials.authenticate(issued.token), /revogada|inválida/i);
});

test("alterar o papel do usuário também revoga suas credenciais", async () => {
  const { auth, sessionToken, credentials } = await fixture();
  const operator = await auth.createUser(sessionToken, {
    username: "operador-papel",
    displayName: "Operador Papel",
    role: "operator",
    password: "senha segura do operador",
  });
  const issued = credentials.create(operator.id, {
    name: "Hermes",
    clientId: "hermes",
    expiresAt: "2026-12-24T15:00:00.000Z",
  });

  auth.updateUser(sessionToken, operator.id, { role: "viewer" });

  assert.throws(() => credentials.authenticate(issued.token), /revogada|inválida/i);
});
