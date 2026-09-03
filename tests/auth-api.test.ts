import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AiProviderSettingsService } from "../server/agent/provider-settings.js";
import { LocalAuthService, SetupChallengeService } from "../server/auth/index.js";
import { LocalAccessToken } from "../server/auth/local-access-token.js";
import { createDatabase } from "../server/db/index.js";
import { SupportStore } from "../server/domain/index.js";
import { createApiApp } from "../server/index.js";
import { LocalSecretVault } from "../server/runtime/secret-vault.js";
import { LocalSettingsFile } from "../server/runtime/local-settings.js";

test("API sem serviço de autenticação falha fechada", async () => {
  const database = createDatabase(":memory:");
  try {
    const app = createApiApp(new SupportStore(database));
    const read = await app.request("/api/runtime");
    const mutation = await app.request("/api/settings/workspace", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceName: "Não autorizado" }),
    });

    assert.equal(read.status, 503);
    assert.equal(mutation.status, 503);
    assert.equal(
      (database.prepare("SELECT COUNT(*) AS count FROM local_app_settings").get() as {
        count: number;
      }).count,
      0,
    );
  } finally {
    database.close();
  }
});

test("API exige sessão, conclui bootstrap e aplica papéis sem confiar no navegador", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadmark-auth-api-"));
  const database = createDatabase(":memory:");
  try {
    const store = new SupportStore(database);
    const auth = new LocalAuthService(database);
    const challenges = new SetupChallengeService(database);
    const localAccessToken = new LocalAccessToken(path.join(root, "local.token"));
    const localSettings = new LocalSettingsFile(path.join(root, "settings.json"));
    const app = createApiApp(store, undefined, undefined, {
      auth,
      setupChallenges: challenges,
      localAccessToken,
      localSettings,
      aiSettings: new AiProviderSettingsService(
        database,
        new LocalSecretVault(path.join(root, "secrets")),
      ),
    });

    const denied = await app.request("/api/runtime");
    assert.equal(denied.status, 401);

    const challenge = challenges.issue();
    const setup = await app.request("/api/setup/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bootstrapToken: challenge.token,
        workspaceName: "Atendimento",
        organizationName: "Loja Exemplo",
        timezone: "America/Sao_Paulo",
        login: "admin",
        displayName: "Pessoa Admin",
        password: "senha-local-forte-123",
      }),
    });
    assert.equal(setup.status, 201);
    const cookie = setup.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie?.startsWith("threadmark_session="));
    assert.match(setup.headers.get("set-cookie") ?? "", /HttpOnly/i);
    assert.match(setup.headers.get("set-cookie") ?? "", /SameSite=Strict/i);

    const me = await app.request("/api/auth/me", { headers: { cookie: cookie! } });
    assert.equal(me.status, 200);
    assert.equal(((await me.json()) as { user: { displayName: string } }).user.displayName, "Pessoa Admin");

    const localToken = await localAccessToken.ensure();
    const machine = await app.request("/api/runtime", {
      headers: { authorization: `Bearer ${localToken}` },
    });
    assert.equal(machine.status, 200);

    const createViewer = await app.request("/api/users", {
      method: "POST",
      headers: { cookie: cookie!, "content-type": "application/json" },
      body: JSON.stringify({
        username: "viewer",
        displayName: "Pessoa Leitura",
        role: "viewer",
        password: "outra-senha-local-123",
      }),
    });
    assert.equal(createViewer.status, 201);
    const viewerLogin = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "viewer", password: "outra-senha-local-123" }),
    });
    const viewerCookie = viewerLogin.headers.get("set-cookie")?.split(";")[0];
    const forbidden = await app.request("/api/settings/workspace", {
      method: "PATCH",
      headers: { cookie: viewerCookie!, "content-type": "application/json" },
      body: JSON.stringify({ workspaceName: "Não autorizado" }),
    });
    assert.equal(forbidden.status, 403);
    const readableWorkspace = await app.request("/api/settings/workspace", {
      headers: { cookie: viewerCookie! },
    });
    assert.equal(readableWorkspace.status, 200);

    const invalidTimezone = await app.request("/api/settings/workspace", {
      method: "PATCH",
      headers: { cookie: cookie!, "content-type": "application/json" },
      body: JSON.stringify({ timezone: "Planeta/Desconhecido" }),
    });
    assert.equal(invalidTimezone.status, 400);

    const staffUpdate = await app.request("/api/settings/staff", {
      method: "PUT",
      headers: { cookie: cookie!, "content-type": "application/json" },
      body: JSON.stringify({ identities: ["55 (11) 90000-0001"] }),
    });
    assert.equal(staffUpdate.status, 200);
    assert.equal(
      ((await staffUpdate.json()) as { restartRequired: boolean }).restartRequired,
      true,
    );
    const staffReload = await app.request("/api/settings/staff", {
      headers: { cookie: cookie! },
    });
    const staffPayload = (await staffReload.json()) as {
      identities: string[];
      restartRequired: boolean;
    };
    assert.deepEqual(staffPayload.identities, ["55 (11) 90000-0001"]);
    assert.equal(staffPayload.restartRequired, true);
    assert.equal((await localSettings.read()).staffIdentitiesConfigured, true);

    const csrf = await app.request("/api/settings/workspace", {
      method: "PATCH",
      headers: {
        cookie: cookie!,
        "content-type": "application/json",
        origin: "https://example.com",
      },
      body: JSON.stringify({ workspaceName: "Origem indevida" }),
    });
    assert.equal(csrf.status, 403);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("API atribui mutações da CLI ao usuário delegado sem confiar em nomes livres", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadmark-agent-actor-"));
  const database = createDatabase(":memory:");
  try {
    const store = new SupportStore(database);
    const account = store.upsertAccount({
      phoneNumber: "threadmark-test-account",
      displayName: "Conta local",
    });
    const client = store.upsertClient({
      name: "Cliente delegado",
      slug: "cliente-delegado",
      kind: "ecommerce",
    });
    const group = store.upsertGroup({
      accountId: account.id,
      clientId: client.id,
      externalJid: "delegated@g.us",
      subject: "Grupo delegado",
    });
    const participant = store.upsertParticipant({
      externalJid: "delegated-test@s.whatsapp.net",
      displayName: "Cliente",
    });
    const message = store.upsertMessage({
      externalId: "delegated-message",
      groupId: group.id,
      senderId: participant.id,
      occurredAt: "2026-09-02T12:00:00.000Z",
      text: "Preciso de ajuda.",
      messageType: "text",
      triageKind: "demand",
    });
    const ticket = store.createTicket({
      groupId: group.id,
      sourceMessageId: message.id,
      title: "Ajuda delegada",
      summary: "Cliente pediu ajuda.",
    });
    const auth = new LocalAuthService(database);
    const challenges = new SetupChallengeService(database);
    const localAccessToken = new LocalAccessToken(path.join(root, "local.token"));
    const app = createApiApp(store, undefined, undefined, {
      auth,
      setupChallenges: challenges,
      localAccessToken,
      localSettings: new LocalSettingsFile(path.join(root, "settings.json")),
      aiSettings: new AiProviderSettingsService(
        database,
        new LocalSecretVault(path.join(root, "secrets")),
      ),
    });
    const challenge = challenges.issue();
    const setup = await app.request("/api/setup/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bootstrapToken: challenge.token,
        workspaceName: "Atendimento",
        organizationName: "Empresa",
        timezone: "America/Sao_Paulo",
        login: "operador",
        displayName: "Pessoa Operadora",
        password: "senha-local-forte-123",
      }),
    });
    const setupBody = (await setup.json()) as { user: { id: string } };
    const machineToken = await localAccessToken.ensure();

    const localClaim = await app.request("/api/agent/triage/jobs/claim", {
      method: "POST",
      headers: {
        authorization: `Bearer ${machineToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ leaseSeconds: 60 }),
    });
    assert.equal(localClaim.status, 403);

    const delegatedClaim = await app.request("/api/agent/triage/jobs/claim", {
      method: "POST",
      headers: {
        authorization: `Bearer ${machineToken}`,
        "content-type": "application/json",
        "x-threadmark-actor-id": setupBody.user.id,
        "x-threadmark-agent-client": "hermes",
      },
      body: JSON.stringify({ leaseSeconds: 60 }),
    });
    assert.equal(delegatedClaim.status, 200);
    assert.deepEqual(await delegatedClaim.json(), { job: null });

    const updated = await app.request(`/api/tickets/${ticket.id}/status`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${machineToken}`,
        "content-type": "application/json",
        "x-threadmark-actor-id": setupBody.user.id,
        "x-threadmark-agent-client": "hermes",
      },
      body: JSON.stringify({ status: "in_progress" }),
    });
    assert.equal(updated.status, 200);
    const detail = (await updated.json()) as {
      timeline: Array<{ type: string; eventType?: string; actor?: string }>;
    };
    assert.ok(
      detail.timeline.some(
        (item) =>
          item.type === "event" &&
          item.eventType === "status_changed" &&
          item.actor === "Hermes · Pessoa Operadora",
      ),
    );

    const forged = await app.request(`/api/tickets/${ticket.id}/status`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${machineToken}`,
        "content-type": "application/json",
        "x-threadmark-actor-id": "usuario-inexistente",
        "x-threadmark-agent-client": "hermes",
      },
      body: JSON.stringify({ status: "waiting_customer" }),
    });
    assert.equal(forged.status, 404);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
