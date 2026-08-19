import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AutomationRuntime } from "../server/automation-runtime/index.js";
import { createDatabase } from "../server/db/index.js";
import { SupportStore } from "../server/domain/index.js";
import { createTestApiApp } from "../server/index.js";
import { NotificationService } from "../server/notifications/index.js";
import { LocalSecretVault } from "../server/runtime/secret-vault.js";

function addUser(
  database: ReturnType<typeof createDatabase>,
  id: string,
  displayName: string,
  active = true,
) {
  const timestamp = new Date().toISOString();
  database.prepare(`
    INSERT INTO local_users (
      id, username, display_name, role, password_hash, active,
      failed_login_attempts, locked_until, last_login_at,
      password_changed_at, created_at, updated_at
    ) VALUES (?, ?, ?, 'operator', 'test-hash', ?, 0, NULL, NULL, ?, ?, ?)
  `).run(id, id, displayName, active ? 1 : 0, timestamp, timestamp, timestamp);
}

function addTicket(store: SupportStore) {
  const account = store.upsertAccount({ phoneNumber: "+550000000000", displayName: "Comercial" });
  const client = store.upsertClient({ name: "Empresa exemplo", slug: "notificacao", kind: "ecommerce" });
  const group = store.upsertGroup({
    accountId: account.id,
    clientId: client.id,
    externalJid: "notification@g.us",
    subject: "Atendimento notificações",
  });
  const participant = store.upsertParticipant({
    externalJid: "notification@s.whatsapp.net",
    displayName: "Pessoa cliente",
  });
  store.addGroupParticipant(group.id, participant.id);
  const message = store.upsertMessage({
    externalId: "notification-message",
    groupId: group.id,
    senderId: participant.id,
    occurredAt: new Date().toISOString(),
    text: "Preciso de ajuda.",
    messageType: "text",
    triageKind: "demand",
  });
  return store.createTicket({
    groupId: group.id,
    sourceMessageId: message.id,
    title: "Configurar acesso",
    summary: "Cliente precisa de ajuda.",
  });
}

test("central persiste por usuário, deduplica e controla leitura", () => {
  const database = createDatabase(":memory:");
  try {
    addUser(database, "one", "Primeira pessoa");
    addUser(database, "two", "Segunda pessoa");
    addUser(database, "inactive", "Pessoa inativa", false);
    const notifications = new NotificationService(database);
    const input = {
      title: "Ticket precisa de atenção",
      body: "O cliente aguarda uma resposta.",
      targetUrl: "/tickets/42",
      sourceType: "automation" as const,
      sourceId: "run-1",
      idempotencyKey: "run-1:node-1",
    };

    assert.deepEqual(notifications.createForAll(input), { created: 2, deduplicated: 0 });
    assert.deepEqual(notifications.createForAll(input), { created: 0, deduplicated: 2 });
    const first = notifications.listForUser("one");
    assert.equal(first.total, 1);
    assert.equal(first.unread, 1);
    assert.equal(first.items[0]?.targetUrl, "/tickets/42");
    assert.equal(notifications.listForUser("inactive").total, 0);

    assert.equal(notifications.markRead("one", first.items[0]!.id, true), true);
    assert.equal(notifications.unreadCount("one"), 0);
    assert.equal(notifications.markRead("one", first.items[0]!.id, false), true);
    assert.equal(notifications.markAllRead("one"), 1);
    assert.equal(notifications.unreadCount("one"), 0);
  } finally {
    database.close();
  }
});

test("API lista e atualiza somente as notificações do usuário atual", async () => {
  const database = createDatabase(":memory:");
  try {
    addUser(database, "local-machine", "Threadmark local");
    const notifications = new NotificationService(database);
    notifications.createForUsers(["local-machine"], {
      title: "Aviso interno",
      body: "Uma automação terminou.",
      sourceType: "system",
      idempotencyKey: "api-notification",
    });
    const app = createTestApiApp(new SupportStore(database), undefined, undefined, { notifications });

    const listResponse = await app.request("/api/notifications?limit=20&offset=0");
    assert.equal(listResponse.status, 200);
    const list = await listResponse.json() as { items: Array<{ id: string }>; unread: number };
    assert.equal(list.unread, 1);

    const readResponse = await app.request(`/api/notifications/${list.items[0]!.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ read: true }),
    });
    assert.equal(readResponse.status, 200);
    assert.equal((await readResponse.json() as { unread: number }).unread, 0);

    const allResponse = await app.request("/api/notifications/read-all", { method: "POST" });
    assert.equal(allResponse.status, 200);
  } finally {
    database.close();
  }
});

test("automação cria notificação interna renderizada para o responsável", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "threadmark-notification-runtime-"));
  const database = createDatabase(":memory:");
  const support = new SupportStore(database);
  const notifications = new NotificationService(database);
  addUser(database, "operator-1", "Pessoa responsável");
  const runtime = new AutomationRuntime(
    database,
    support,
    new LocalSecretVault(directory),
    { pollIntervalMs: 5, notifications },
  );
  try {
    const ticket = addTicket(support);
    support.updateTicketAssignee(ticket.id, "operator-1", "Teste");
    const workflow = runtime.workflows.createWorkflow({
      name: "Avisar responsável",
      actor: "Teste",
      definition: {
        nodes: [
          { id: "trigger", type: "trigger", config: { eventType: "ticket_created" } },
          {
            id: "notification",
            type: "internal_action",
            config: {
              actionId: "create_in_app_notification",
              input: {
                recipient: "assignee",
                title: "Ticket #{{ticket.number}} aguarda atenção",
                body: "{{ticket.title}}",
                targetUrl: "/tickets/{{ticket.number}}",
              },
            },
          },
        ],
        edges: [{ id: "trigger-notification", source: "trigger", target: "notification" }],
      },
    });
    runtime.workflows.setWorkflowStatus(workflow.id, "active", "Teste");
    runtime.engine.dispatchEvent({
      eventType: "ticket_created",
      subjectType: "ticket",
      subjectId: ticket.id,
      payload: { ticketId: ticket.id },
      idempotencyKey: "ticket-created-notification",
    });
    await runtime.engine.runUntilIdle();

    const result = notifications.listForUser("operator-1");
    assert.equal(result.total, 1);
    assert.match(result.items[0]!.title, new RegExp(`#${ticket.number}`));
    assert.equal(result.items[0]!.body, "Configurar acesso");
    assert.equal(result.items[0]!.targetUrl, `/tickets/${ticket.number}`);
  } finally {
    await runtime.stop();
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
