import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { createDatabase, type SupportDatabase } from "../server/db/index.js";
import {
  ConflictError,
  SupportStore,
  ValidationError,
} from "../server/domain/index.js";
import { createTestApiApp } from "../server/index.js";

const databases: SupportDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function bulkFixture() {
  const database = createDatabase(":memory:");
  databases.push(database);
  const store = new SupportStore(database);
  const account = store.upsertAccount({
    id: "bulk-account",
    phoneNumber: "+5548999999999",
    displayName: "Acme",
  });
  const client = store.upsertClient({
    id: "bulk-client",
    name: "Cliente do Kanban",
    slug: "cliente-do-kanban",
    kind: "ecommerce",
  });
  const group = store.upsertGroup({
    id: "bulk-group",
    accountId: account.id,
    clientId: client.id,
    externalJid: "bulk-status@g.us",
    subject: "Acme + Cliente do Kanban",
  });
  const participant = store.upsertParticipant({
    id: "bulk-participant",
    externalJid: "5547999999999@s.whatsapp.net",
    displayName: "Cliente",
  });
  store.addGroupParticipant(group.id, participant.id);

  function createTicket(id: string, status: "new" | "resolved", createdAt: string) {
    const message = store.upsertMessage({
      id: `${id}-message`,
      externalId: `${id}-external`,
      groupId: group.id,
      senderId: participant.id,
      occurredAt: createdAt,
      text: `Mensagem de ${id}`,
      messageType: "text",
      triageKind: "demand",
    });
    return store.createTicket({
      id,
      groupId: group.id,
      sourceMessageId: message.id,
      title: `Ticket ${id}`,
      summary: `Resumo de ${id}`,
      status,
      createdAt,
    });
  }

  const resolvedA = createTicket(
    "bulk-resolved-a",
    "resolved",
    "2026-07-16T12:00:00.000Z",
  );
  const resolvedB = createTicket(
    "bulk-resolved-b",
    "resolved",
    "2026-07-16T12:01:00.000Z",
  );
  const open = createTicket(
    "bulk-open",
    "new",
    "2026-07-16T12:02:00.000Z",
  );

  return {
    database,
    store,
    app: createTestApiApp(store),
    resolvedA,
    resolvedB,
    open,
  };
}

test("store arquiva e restaura tickets resolvidos em uma única transação", () => {
  const { database, store, resolvedA, resolvedB } = bulkFixture();
  const originalResolvedAt = new Map([
    [resolvedA.id, resolvedA.resolvedAt],
    [resolvedB.id, resolvedB.resolvedAt],
  ]);

  const archived = store.updateTicketStatusesInBulk({
    ticketIds: [resolvedA.id, resolvedB.id],
    status: "archived",
    actor: "Operador",
    reason: "Limpeza dos concluídos do Kanban.",
  });

  assert.equal(archived.action, "archive");
  assert.equal(archived.tickets.length, 2);
  assert.deepEqual(
    archived.tickets.map((ticket) => ticket.status),
    ["archived", "archived"],
  );
  assert.deepEqual(
    archived.tickets.map((ticket) => ticket.archivedAt),
    [archived.changedAt, archived.changedAt],
  );
  assert.deepEqual(
    archived.tickets.map((ticket) => ticket.resolvedAt),
    [originalResolvedAt.get(resolvedA.id), originalResolvedAt.get(resolvedB.id)],
  );

  const archiveEvents = database
    .prepare(
      `SELECT ticket_id, actor, from_status, to_status, data_json
       FROM ticket_events
       WHERE json_extract(data_json, '$.batchId') = ?
       ORDER BY ticket_id`,
    )
    .all(archived.batchId) as Array<{
    ticket_id: string;
    actor: string;
    from_status: string;
    to_status: string;
    data_json: string;
  }>;
  assert.equal(archiveEvents.length, 2);
  assert.ok(
    archiveEvents.every(
      (event) =>
        event.actor === "Operador" &&
        event.from_status === "resolved" &&
        event.to_status === "archived" &&
        JSON.parse(event.data_json).description ===
          "Ticket arquivado em lote por Operador.",
    ),
  );

  const restored = store.updateTicketStatusesInBulk({
    ticketIds: [resolvedA.id, resolvedB.id],
    status: "resolved",
    actor: "Operador",
  });
  assert.equal(restored.action, "restore");
  assert.deepEqual(
    restored.tickets.map((ticket) => ticket.status),
    ["resolved", "resolved"],
  );
  assert.deepEqual(
    restored.tickets.map((ticket) => ticket.archivedAt),
    [null, null],
  );
  assert.deepEqual(
    restored.tickets.map((ticket) => ticket.resolvedAt),
    [originalResolvedAt.get(resolvedA.id), originalResolvedAt.get(resolvedB.id)],
  );
  const restoreEvents = database
    .prepare(
      `SELECT from_status, to_status, data_json
       FROM ticket_events
       WHERE json_extract(data_json, '$.batchId') = ?`,
    )
    .all(restored.batchId) as Array<{
    from_status: string;
    to_status: string;
    data_json: string;
  }>;
  assert.equal(restoreEvents.length, 2);
  assert.ok(
    restoreEvents.every(
      (event) =>
        event.from_status === "archived" &&
        event.to_status === "resolved" &&
        JSON.parse(event.data_json).description ===
          "Ticket restaurado em lote para Resolvido por Operador.",
    ),
  );
});

test("store rejeita duplicados, ausentes e status incompatível sem alteração parcial", () => {
  const { database, store, resolvedA, resolvedB, open } = bulkFixture();
  const eventCountBefore = (
    database.prepare("SELECT COUNT(*) AS count FROM ticket_events").get() as {
      count: number;
    }
  ).count;

  assert.throws(
    () =>
      store.updateTicketStatusesInBulk({
        ticketIds: [resolvedA.id, resolvedA.id],
        status: "archived",
      }),
    ValidationError,
  );
  assert.throws(
    () =>
      store.updateTicketStatusesInBulk({
        ticketIds: [resolvedA.id, "ticket-inexistente"],
        status: "archived",
      }),
    ValidationError,
  );
  assert.throws(
    () =>
      store.updateTicketStatusesInBulk({
        ticketIds: [resolvedA.id, open.id],
        status: "archived",
      }),
    ConflictError,
  );

  assert.deepEqual(
    [resolvedA.id, resolvedB.id, open.id].map(
      (ticketId) => store.getTicketDetail(ticketId).status,
    ),
    ["resolved", "resolved", "new"],
  );
  const eventCountAfter = (
    database.prepare("SELECT COUNT(*) AS count FROM ticket_events").get() as {
      count: number;
    }
  ).count;
  assert.equal(eventCountAfter, eventCountBefore);
});

test("API arquiva, restaura e lista arquivados pela data real", async () => {
  const { app, database, resolvedA, resolvedB } = bulkFixture();
  const archiveResponse = await app.request("/api/tickets/bulk-status", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ticketIds: [resolvedA.id, resolvedB.id],
      status: "archived",
      actor: "Operador",
    }),
  });
  assert.equal(archiveResponse.status, 200);
  const archived = (await archiveResponse.json()) as {
    action: string;
    tickets: Array<{ id: string; status: string; archivedAt: string | null }>;
  };
  assert.equal(archived.action, "archive");
  assert.deepEqual(
    archived.tickets.map((ticket) => ticket.status),
    ["archived", "archived"],
  );

  database
    .prepare("UPDATE tickets SET archived_at = ? WHERE id = ?")
    .run("2026-07-17T10:00:00.000Z", resolvedA.id);
  database
    .prepare("UPDATE tickets SET archived_at = ? WHERE id = ?")
    .run("2026-07-18T10:00:00.000Z", resolvedB.id);
  const listResponse = await app.request(
    "/api/tickets?status=archived&order=archived_desc&limit=1&offset=0",
  );
  assert.equal(listResponse.status, 200);
  const list = (await listResponse.json()) as {
    total: number;
    items: Array<{ id: string; archivedAt: string | null }>;
  };
  assert.equal(list.total, 2);
  assert.deepEqual(
    list.items.map((ticket) => ({
      id: ticket.id,
      archivedAt: ticket.archivedAt,
    })),
    [{ id: resolvedB.id, archivedAt: "2026-07-18T10:00:00.000Z" }],
  );

  const restoreResponse = await app.request("/api/tickets/bulk-status", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ticketIds: [resolvedA.id, resolvedB.id],
      status: "resolved",
      actor: "Operador",
    }),
  });
  assert.equal(restoreResponse.status, 200);
  const restored = (await restoreResponse.json()) as {
    action: string;
    tickets: Array<{ status: string; archivedAt: string | null }>;
  };
  assert.equal(restored.action, "restore");
  assert.deepEqual(
    restored.tickets.map((ticket) => [ticket.status, ticket.archivedAt]),
    [
      ["resolved", null],
      ["resolved", null],
    ],
  );
});

test("API rejeita lote inválido sem arquivar o subconjunto válido", async () => {
  const { app, store, resolvedA, open } = bulkFixture();
  const duplicate = await app.request("/api/tickets/bulk-status", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ticketIds: [resolvedA.id, resolvedA.id],
      status: "archived",
    }),
  });
  const incompatible = await app.request("/api/tickets/bulk-status", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ticketIds: [resolvedA.id, open.id],
      status: "archived",
    }),
  });
  const missing = await app.request("/api/tickets/bulk-status", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ticketIds: [resolvedA.id, "ticket-inexistente"],
      status: "archived",
    }),
  });

  assert.equal(duplicate.status, 400);
  assert.equal(incompatible.status, 409);
  assert.equal(missing.status, 400);
  assert.equal(store.getTicketDetail(resolvedA.id).status, "resolved");
  assert.equal(store.getTicketDetail(open.id).status, "new");
});

test("API pagina Done pela resolução mais recente", async () => {
  const { app, resolvedB } = bulkFixture();
  const response = await app.request(
    "/api/tickets?status=resolved&order=resolved_desc&limit=1&offset=0",
  );
  assert.equal(response.status, 200);
  const list = (await response.json()) as {
    total: number;
    items: Array<{ id: string; resolvedAt: string | null }>;
  };
  assert.equal(list.total, 2);
  assert.deepEqual(
    list.items.map((ticket) => ({
      id: ticket.id,
      resolvedAt: ticket.resolvedAt,
    })),
    [{ id: resolvedB.id, resolvedAt: "2026-07-16T12:01:00.000Z" }],
  );
});
