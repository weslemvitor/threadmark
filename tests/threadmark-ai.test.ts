import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";

import type { InvestigationThreadInput, InvestigationTurnResult } from "../server/agent/types.js";
import { InvestigationWorker } from "../server/agent/investigation-worker.js";
import { createDatabase, type SupportDatabase } from "../server/db/index.js";
import { SupportStore } from "../server/domain/index.js";
import { createTestApiApp } from "../server/index.js";

const databases: SupportDatabase[] = [];
const GROUP_NAME = "Grupo Exemplo";

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function fixture(attachmentsDirectory?: string) {
  const database = createDatabase(":memory:");
  databases.push(database);
  const store = new SupportStore(database);
  const account = store.upsertAccount({
    id: "account-ai",
    phoneNumber: "+5548999999000",
    displayName: "Comercial",
  });
  const client = store.upsertClient({
    id: "client-ai",
    name: "Cliente Exemplo",
    slug: "cliente-exemplo",
    kind: "ecommerce",
  });
  const group = store.upsertGroup({
    id: "group-ai",
    accountId: account.id,
    clientId: client.id,
    externalJid: "ai@g.us",
    subject: GROUP_NAME,
  });
  const participant = store.upsertParticipant({
    id: "participant-ai",
    externalJid: "client-ai@s.whatsapp.net",
    displayName: "Cliente",
  });
  store.addGroupParticipant(group.id, participant.id);
  const message = store.upsertMessage({
    id: "message-ai",
    externalId: "wa-ai",
    groupId: group.id,
    senderId: participant.id,
    occurredAt: "2026-08-20T12:00:00.000Z",
    text: "O total do dashboard está diferente.",
    messageType: "text",
    triageKind: "demand",
  });
  const ticket = store.createTicket({
    id: "ticket-ai",
    groupId: group.id,
    sourceMessageId: message.id,
    title: "Divergência no dashboard",
    summary: "Cliente questiona o total exibido.",
  });
  return {
    database,
    store,
    ticket,
    group,
    app: createTestApiApp(
      store,
      undefined,
      undefined,
      attachmentsDirectory ? { attachmentsDirectory } : {},
    ),
  };
}

function result(): InvestigationTurnResult {
  return {
    assistantMessage: "O ticket relata uma divergência no dashboard.",
    phase: "conclusion",
    threadSummary: "Ticket localizado e contexto lido.",
    evidence: [
      {
        source: "conversation",
        summary: "Relato do cliente no ticket.",
        reference: "message-ai",
      },
    ],
    suggestedResponse: "Vou validar o período e a definição dessa métrica.",
    nextAction: "Revise a resposta antes de copiar manualmente.",
    confidence: 0.92,
    toolRequests: [],
  };
}

test("Threadmark AI persiste conversa global e o contexto visível no SQLite", () => {
  const current = fixture();
  const thread = current.store.getOrCreateThreadmarkAiThread("Operador", {
    route: `/tickets/${current.ticket.number}`,
    label: `Ticket #${current.ticket.number}`,
    ticketId: current.ticket.id,
    ticketNumber: current.ticket.number,
    groupId: current.group.id,
    groupName: GROUP_NAME,
  });
  assert.equal(thread.scope, "workspace");
  assert.equal(thread.ticketId, null);

  const queued = current.store.addThreadmarkAiMessage(thread.id, {
    body: `Explique o ticket #${current.ticket.number}.`,
    clientMessageId: "browser-ai-1",
    context: {
      route: `/tickets/${current.ticket.number}`,
      label: `Ticket #${current.ticket.number}`,
      ticketId: current.ticket.id,
      ticketNumber: current.ticket.number,
      groupId: current.group.id,
      groupName: GROUP_NAME,
    },
  });
  assert.equal(queued.activeTurnState, "queued");
  assert.equal(queued.messages[0]?.context?.ticketId, current.ticket.id);
  assert.match(queued.title, /Explique o ticket/);

  const persisted = current.database
    .prepare("SELECT scope, ticket_id, context_json FROM investigation_threads WHERE id = ?")
    .get(thread.id) as { scope: string; ticket_id: string | null; context_json: string };
  assert.equal(persisted.scope, "workspace");
  assert.equal(persisted.ticket_id, null);
  assert.match(persisted.context_json, new RegExp(current.ticket.id));
});

test("worker processa Threadmark AI sem ticket sintético e mantém o chat ativo", async () => {
  const current = fixture();
  const thread = current.store.createThreadmarkAiThread({}, "Operador");
  current.store.addThreadmarkAiMessage(thread.id, {
    body: `Analise o ticket #${current.ticket.number}.`,
  });
  let received!: InvestigationThreadInput;
  const worker = new InvestigationWorker(
    current.store,
    {
      async analyse() {
        throw new Error("não esperado");
      },
      async investigateThread(input) {
        received = input;
        return result();
      },
    },
    { recoverOrphanedJobs: false },
  );

  assert.equal(await worker.runOne(), true);
  assert.equal(received.mode, "workspace");
  assert.equal(received.ticket.ticketId, current.ticket.id);
  const completed = current.store.getThreadmarkAiThread(thread.id);
  assert.equal(completed.status, "active");
  assert.equal(completed.activeTurnState, null);
  assert.equal(completed.messages.at(-1)?.role, "assistant");
  assert.equal(completed.messages.at(-1)?.suggestedResponse, "Vou validar o período e a definição dessa métrica.");
});

test("API global cria, lista, envia, consulta e cancela conversas sem rota WhatsApp", async () => {
  const current = fixture();
  const createdResponse = await current.app.request("/api/threadmark-ai/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Análise geral" }),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json() as { id: string; ticketId: null; scope: string };
  assert.equal(created.ticketId, null);
  assert.equal(created.scope, "workspace");

  const messageResponse = await current.app.request(
    `/api/threadmark-ai/threads/${created.id}/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "Quais tickets precisam de atenção?" }),
    },
  );
  assert.equal(messageResponse.status, 202);

  const listResponse = await current.app.request("/api/threadmark-ai/threads");
  assert.equal(listResponse.status, 200);
  const listed = await listResponse.json() as { items: Array<{ id: string }> };
  assert.equal(listed.items[0]?.id, created.id);

  const source = [
    "/api/threadmark-ai/threads",
    "/api/threadmark-ai/current",
    "/api/threadmark-ai/threads/:id/messages",
  ].join("\n");
  assert.doesNotMatch(source, /sendMessage|whatsapp.*send/i);
});

test("Threadmark AI persiste imagem consentida e a entrega ao contexto multimodal", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "threadmark-ai-images-"));
  const current = fixture(temporary);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );

  try {
    const thread = current.store.createThreadmarkAiThread({}, "Operador");
    const response = await current.app.request(
      `/api/threadmark-ai/threads/${thread.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          body: "Analise este print.",
          clientMessageId: "threadmark-image-1",
          allowImageAnalysis: true,
          attachments: [{
            fileName: "print.png",
            mimeType: "image/png",
            dataBase64: png.toString("base64"),
          }],
        }),
      },
    );
    assert.equal(response.status, 202);
    const updated = await response.json() as {
      messages: Array<{ attachments: Array<{ id: string; url: string }> }>;
    };
    const attachment = updated.messages[0]?.attachments[0];
    assert.ok(attachment);

    const persisted = current.database
      .prepare(
        `SELECT id, local_path, ai_analysis_approved
         FROM investigation_thread_message_attachments WHERE id = ?`,
      )
      .get(attachment.id) as {
      id: string;
      local_path: string;
      ai_analysis_approved: number;
    };
    assert.equal(persisted.ai_analysis_approved, 1);
    assert.deepEqual(await readFile(persisted.local_path), png);

    const fileResponse = await current.app.request(attachment.url);
    assert.equal(fileResponse.status, 200);
    assert.equal(fileResponse.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await fileResponse.arrayBuffer()), png);

    const job = current.database
      .prepare(
        `SELECT id FROM investigation_thread_jobs
         WHERE thread_id = ? AND state = 'queued'`,
      )
      .get(thread.id) as { id: string };
    const context = current.store.getInvestigationThreadContext(job.id);
    assert.equal(context.imageAnalysisApproved, true);
    assert.equal(context.images?.[0]?.id, attachment.id);
    assert.equal(context.images?.[0]?.localPath, persisted.local_path);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("Threadmark AI bloqueia imagem sem consentimento para o provedor configurado", async () => {
  const current = fixture();
  const thread = current.store.createThreadmarkAiThread({}, "Operador");
  const response = await current.app.request(
    `/api/threadmark-ai/threads/${thread.id}/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "Analise este print.",
        attachments: [{
          fileName: "print.png",
          mimeType: "image/png",
          dataBase64: "iVBORw0KGgo=",
        }],
      }),
    },
  );
  assert.equal(response.status, 400);
  assert.deepEqual(
    current.database.prepare(
      "SELECT COUNT(*) AS count FROM investigation_thread_message_attachments",
    ).get(),
    { count: 0 },
  );
});

test("Threadmark AI permite retomar manualmente o mesmo turno bloqueado", async () => {
  const current = fixture();
  const thread = current.store.createThreadmarkAiThread({}, "Operador");
  current.store.addThreadmarkAiMessage(thread.id, { body: "Investigue novamente." });
  const claimed = current.store.claimNextAgentJob();
  assert.ok(claimed && claimed.kind === "thread_turn");
  current.store.failInvestigationThreadJob(claimed.id, "provedor indisponível");

  const response = await current.app.request(
    `/api/threadmark-ai/threads/${thread.id}/retry`,
    { method: "POST" },
  );
  assert.equal(response.status, 202);
  const retried = await response.json() as {
    activeTurnState: string | null;
    messages: Array<{ role: string }>;
    turns: Array<{ attemptCount: number; state: string }>;
  };
  assert.equal(retried.activeTurnState, "queued");
  assert.equal(retried.messages.length, 1);
  assert.equal(retried.messages[0]?.role, "operator");
  assert.equal(retried.turns[0]?.state, "queued");
  assert.equal(retried.turns[0]?.attemptCount, 0);
});
