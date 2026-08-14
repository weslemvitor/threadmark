import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { createDatabase, type SupportDatabase } from "../server/db/index.js";
import { SupportStore } from "../server/domain/index.js";
import { createTestApiApp } from "../server/index.js";

const databases: SupportDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function dashboardFixture() {
  const database = createDatabase(":memory:");
  databases.push(database);
  const store = new SupportStore(database);
  const account = store.upsertAccount({
    id: "dashboard-account",
    phoneNumber: "+5548999999999",
    displayName: "Acme",
  });
  const clientA = store.upsertClient({
    id: "dashboard-client-a",
    name: "Agência Alpha",
    slug: "agencia-alpha",
    kind: "agency",
  });
  const clientB = store.upsertClient({
    id: "dashboard-client-b",
    name: "Loja Beta",
    slug: "loja-beta",
    kind: "ecommerce",
  });
  const groupA = store.upsertGroup({
    id: "dashboard-group-a",
    accountId: account.id,
    clientId: clientA.id,
    externalJid: "dashboard-a@g.us",
    subject: "Acme + Agência Alpha",
  });
  const groupB = store.upsertGroup({
    id: "dashboard-group-b",
    accountId: account.id,
    clientId: clientB.id,
    externalJid: "dashboard-b@g.us",
    subject: "Acme + Loja Beta",
  });
  const participant = store.upsertParticipant({
    id: "dashboard-participant",
    externalJid: "5547999999999@s.whatsapp.net",
    displayName: "Cliente",
  });
  store.addGroupParticipant(groupA.id, participant.id);
  store.addGroupParticipant(groupB.id, participant.id);

  const dashboardCategory = store.upsertCategory({
    id: "dashboard-category",
    facet: "product",
    slug: "dashboard",
    label: "Dashboard",
  });
  const crmCategory = store.upsertCategory({
    id: "crm-category",
    facet: "product",
    slug: "crm",
    label: "CRM",
  });

  function createTicket(input: {
    id: string;
    client: "a" | "b";
    createdAt: string;
    title?: string;
    status?: "new" | "resolved";
    categoryId?: string;
  }) {
    const group = input.client === "a" ? groupA : groupB;
    const message = store.upsertMessage({
      id: `${input.id}-message`,
      externalId: `${input.id}-external`,
      groupId: group.id,
      senderId: participant.id,
      occurredAt: input.createdAt,
      text: input.title ?? input.id,
      messageType: "text",
      triageKind: "demand",
    });
    return store.createTicket({
      id: input.id,
      groupId: group.id,
      sourceMessageId: message.id,
      title: input.title ?? input.id,
      summary: `Resumo de ${input.id}`,
      createdAt: input.createdAt,
      status: input.status,
      categories: input.categoryId
        ? [{ categoryId: input.categoryId, source: "manual" }]
        : [],
    });
  }

  createTicket({
    id: "ticket-before",
    client: "a",
    createdAt: "2026-07-01T02:59:59.000Z",
  });
  createTicket({
    id: "ticket-inside-resolved",
    client: "a",
    createdAt: "2026-07-01T03:00:00.000Z",
    status: "resolved",
    categoryId: dashboardCategory.id,
  });
  createTicket({
    id: "ticket-inside-archived",
    client: "a",
    createdAt: "2026-07-01T10:00:00.000Z",
    categoryId: dashboardCategory.id,
  });
  database
    .prepare("UPDATE tickets SET status = 'archived', archived_at = ? WHERE id = ?")
    .run("2026-07-01T11:00:00.000Z", "ticket-inside-archived");
  createTicket({
    id: "ticket-inside-open",
    client: "b",
    createdAt: "2026-07-03T02:59:59.000Z",
    title: "=SUM(A1:A2)",
    categoryId: crmCategory.id,
  });
  createTicket({
    id: "ticket-after",
    client: "b",
    createdAt: "2026-07-03T03:00:00.000Z",
  });
  createTicket({
    id: "ticket-old-reopened",
    client: "b",
    createdAt: "2026-06-20T12:00:00.000Z",
  });
  database
    .prepare(
      `INSERT INTO ticket_events
        (id, ticket_id, event_type, actor, from_status, to_status, data_json, occurred_at)
       VALUES (?, ?, 'status_changed', 'Operador', 'new', 'resolved', '{}', ?)`,
    )
    .run(
      "old-ticket-resolution-in-period",
      "ticket-old-reopened",
      "2026-07-02T02:30:00.000Z",
    );
  createTicket({
    id: "ticket-restored-from-archive",
    client: "a",
    createdAt: "2026-06-15T12:00:00.000Z",
    status: "resolved",
  });
  database
    .prepare(
      `INSERT INTO ticket_events
        (id, ticket_id, event_type, actor, from_status, to_status, data_json, occurred_at)
       VALUES
        (?, ?, 'status_changed', 'Operador', 'resolved', 'archived', ?, ?),
        (?, ?, 'status_changed', 'Operador', 'archived', 'resolved', ?, ?)`,
    )
    .run(
      "historical-archive-in-period",
      "ticket-restored-from-archive",
      JSON.stringify({ description: "Ticket arquivado em lote por Operador." }),
      "2026-07-01T14:00:00.000Z",
      "historical-restore-in-period",
      "ticket-restored-from-archive",
      JSON.stringify({
        description: "Ticket restaurado em lote para Resolvido por Operador.",
      }),
      "2026-07-02T14:00:00.000Z",
    );

  store.upsertMessage({
    id: "orphan-current-snapshot",
    externalId: "orphan-current-snapshot-external",
    groupId: groupB.id,
    senderId: participant.id,
    occurredAt: "2026-07-10T12:00:00.000Z",
    text: "Demanda órfã fora do período.",
    messageType: "text",
    triageKind: "uncertain",
  });
  store.upsertMessage({
    id: "orphan-current-snapshot-second-message",
    externalId: "orphan-current-snapshot-second-message-external",
    groupId: groupB.id,
    senderId: participant.id,
    occurredAt: "2026-07-10T12:01:00.000Z",
    text: "Complemento da mesma conversa órfã.",
    messageType: "text",
    triageKind: "demand",
  });

  return { database, store, app: createTestApiApp(store) };
}

test("dashboard interpreta o intervalo inclusivo em America/Sao_Paulo", () => {
  const { store } = dashboardFixture();
  const dashboard = store.getDashboard({ from: "2026-07-01", to: "2026-07-02" });

  assert.deepEqual(dashboard.period, {
    from: "2026-07-01",
    to: "2026-07-02",
    timeZone: "America/Sao_Paulo",
    fromUtc: "2026-07-01T03:00:00.000Z",
    toUtcExclusive: "2026-07-03T03:00:00.000Z",
  });
  assert.deepEqual(dashboard.totals, {
    tickets: 3,
    open: 1,
    needsReview: 1,
    resolved: 2,
    orphanDemands: 1,
    clients: 2,
    groups: 2,
    records: 0,
  });
  assert.deepEqual(dashboard.ticketsByDay, [
    { date: "2026-07-01", created: 2, resolved: 2 },
    { date: "2026-07-02", created: 1, resolved: 0 },
  ]);
  assert.equal(dashboard.topCategories[0]?.category.label, "Dashboard");
  assert.equal(dashboard.topCategories[0]?.count, 2);
  assert.equal(dashboard.topClients[0]?.clientName, "Agência Alpha");
  assert.equal(dashboard.topClients[0]?.count, 2);
  assert.equal(dashboard.topGroups[0]?.groupId, "dashboard-group-a");
  assert.equal(dashboard.topGroups[0]?.count, 2);
  assert.deepEqual(
    dashboard.recentTickets.map((ticket) => ticket.id),
    ["ticket-inside-open", "ticket-inside-archived", "ticket-inside-resolved"],
  );
});

test("API valida o intervalo e exporta CSV readonly com resoluções históricas", async () => {
  const { app, database } = dashboardFixture();
  const invalidRequests = await Promise.all([
    app.request("/api/dashboard?from=2026-07-01"),
    app.request("/api/dashboard?from=2026-02-30&to=2026-03-01"),
    app.request("/api/dashboard?from=2026-07-03&to=2026-07-01"),
  ]);
  assert.deepEqual(invalidRequests.map((response) => response.status), [400, 400, 400]);

  const before = database.prepare("SELECT total_changes() AS count").get() as {
    count: number;
  };
  const response = await app.request(
    "/api/dashboard/export?from=2026-07-01&to=2026-07-02",
    { headers: { Origin: "http://127.0.0.1:3000" } },
  );
  const bytes = new Uint8Array(await response.arrayBuffer());
  const csv = Buffer.from(bytes.subarray(3)).toString("utf8");
  const after = database.prepare("SELECT total_changes() AS count").get() as {
    count: number;
  };

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.equal(
    response.headers.get("access-control-expose-headers"),
    "Content-Disposition",
  );
  assert.match(
    response.headers.get("content-disposition") ?? "",
    /threadmark-dashboard-2026-07-01_2026-07-02\.csv/,
  );
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.match(csv, /"'=SUM\(A1:A2\)"/);
  assert.match(csv, /"ticket-old-reopened"|"Resumo de ticket-old-reopened"/);
  assert.doesNotMatch(csv, /ticket-before/);
  assert.doesNotMatch(csv, /ticket-after/);
  assert.doesNotMatch(csv, /ticket-restored-from-archive/);
  assert.equal(after.count, before.count);
});

test("dashboard interpreta o período no fuso configurado do workspace", () => {
  const { store, database } = dashboardFixture();
  const timestamp = "2026-07-18T00:00:00.000Z";
  database.prepare(
    `INSERT INTO local_app_settings (
       singleton, organization_name, workspace_name, timezone,
       setup_completed_at, created_at, updated_at
     ) VALUES (1, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "Empresa exemplo",
    "Suporte",
    "America/New_York",
    timestamp,
    timestamp,
    timestamp,
  );

  const dashboard = store.getDashboard({
    from: "2026-07-01",
    to: "2026-07-01",
  });

  assert.equal(dashboard.period?.timeZone, "America/New_York");
  assert.equal(dashboard.period?.fromUtc, "2026-07-01T04:00:00.000Z");
  assert.equal(dashboard.period?.toUtcExclusive, "2026-07-02T04:00:00.000Z");
});

test("restaurar arquivado preserva auditoria sem criar uma nova resolução", () => {
  const { database, store } = dashboardFixture();
  const dashboard = store.getDashboard({ from: "2026-07-01", to: "2026-07-02" });
  const exported = store.getDashboardExportRows({
    from: "2026-07-01",
    to: "2026-07-02",
  });
  const ticket = store.getTicketDetail("ticket-restored-from-archive");
  const restoreEvent = database
    .prepare(
      `SELECT COUNT(*) AS count
       FROM ticket_events
       WHERE ticket_id = ? AND from_status = 'archived' AND to_status = 'resolved'`,
    )
    .get(ticket.id) as { count: number };
  const restoreTimelineEvent = ticket.timeline.find(
    (item) =>
      item.type === "event" &&
      item.fromStatus === "archived" &&
      item.toStatus === "resolved",
  );

  assert.equal(dashboard.totals.resolved, 2);
  assert.equal(
    dashboard.ticketsByDay.reduce((total, day) => total + day.resolved, 0),
    2,
  );
  assert.equal(
    exported.some((row) => row.ticketId === ticket.id),
    false,
  );
  assert.equal(ticket.resolvedAt, "2026-06-15T12:00:00.000Z");
  assert.equal(restoreEvent.count, 1);
  assert.ok(restoreTimelineEvent?.type === "event");
  assert.match(restoreTimelineEvent.description, /restaurado em lote/i);
});
