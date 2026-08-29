import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";

import type { InvestigationThreadInput, InvestigationTurnResult } from "../server/agent/types.js";
import { InvestigationWorker } from "../server/agent/investigation-worker.js";
import { LocalAuthService } from "../server/auth/index.js";
import { createDatabase, type SupportDatabase } from "../server/db/index.js";
import { SupportStore } from "../server/domain/index.js";
import { createApiApp, createTestApiApp } from "../server/index.js";
import type { ThreadmarkAiThreadDto } from "../shared/contracts.js";

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
    findings: [{
      statement: "O ticket relata uma divergência no dashboard.",
      kind: "fact",
      evidenceReferences: ["message-ai"],
    }],
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
  assert.equal(completed.unread, true);
  assert.equal(completed.messages.at(-1)?.role, "assistant");
  assert.equal(completed.messages.at(-1)?.suggestedResponse, "Vou validar o período e a definição dessa métrica.");

  const viewed = current.store.markThreadmarkAiThreadRead(thread.id);
  assert.equal(viewed.unread, false);
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

test("Threadmark AI separa conversas por usuário e identifica o autor real", async () => {
  const current = fixture();
  const auth = new LocalAuthService(current.database);
  const operatorOne = await auth.bootstrapSetup({
    organizationName: "Adstart",
    workspaceName: "Suporte",
    timezone: "America/Sao_Paulo",
    username: "operator_one",
    displayName: "Operador Um",
    password: "senha segura do operador um",
  });
  const operatorTwoUser = await auth.createUser(operatorOne.token, {
    username: "operator_two",
    displayName: "Operador Dois",
    role: "operator",
    password: "senha segura do operador dois",
  });
  const operatorTwo = await auth.login({
    username: operatorTwoUser.username,
    password: "senha segura do operador dois",
  });
  const app = createApiApp(current.store, undefined, undefined, { auth });
  const operatorOneCookie = `threadmark_session=${operatorOne.token}`;
  const operatorTwoCookie = `threadmark_session=${operatorTwo.token}`;

  const operatorOneCurrentResponse = await app.request("/api/threadmark-ai/current", {
    method: "POST",
    headers: { cookie: operatorOneCookie, "content-type": "application/json" },
    body: "{}",
  });
  const operatorOneThread = await operatorOneCurrentResponse.json() as ThreadmarkAiThreadDto;

  const operatorTwoCurrentResponse = await app.request("/api/threadmark-ai/current", {
    method: "POST",
    headers: { cookie: operatorTwoCookie, "content-type": "application/json" },
    body: "{}",
  });
  const operatorTwoThread = await operatorTwoCurrentResponse.json() as ThreadmarkAiThreadDto;
  assert.notEqual(operatorTwoThread.id, operatorOneThread.id);

  const sent = await app.request(
    `/api/threadmark-ai/threads/${operatorOneThread.id}/messages`,
    {
      method: "POST",
      headers: { cookie: operatorOneCookie, "content-type": "application/json" },
      body: JSON.stringify({ body: "Investigue este atendimento." }),
    },
  );
  assert.equal(sent.status, 202);
  const updated = await sent.json() as ThreadmarkAiThreadDto;
  assert.deepEqual(updated.messages[0]?.author, {
    userId: operatorOne.user.id,
    displayName: "Operador Um",
  });

  const received = { input: null as InvestigationThreadInput | null };
  const worker = new InvestigationWorker(
    current.store,
    {
      async analyse() {
        throw new Error("não esperado");
      },
      async investigateThread(input) {
        received.input = input;
        return result();
      },
    },
    { recoverOrphanedJobs: false },
  );
  assert.equal(await worker.runOne(), true);
  assert.deepEqual(received.input?.currentOperator, {
    displayName: "Operador Um",
    role: "owner",
  });

  const operatorOneUnreadResponse = await app.request("/api/threadmark-ai/threads", {
    headers: { cookie: operatorOneCookie },
  });
  const operatorOneUnread = await operatorOneUnreadResponse.json() as {
    items: Array<{ id: string; unread: boolean }>;
  };
  assert.equal(operatorOneUnread.items.find((item) => item.id === operatorOneThread.id)?.unread, true);

  const operatorTwoListResponse = await app.request("/api/threadmark-ai/threads", {
    headers: { cookie: operatorTwoCookie },
  });
  const operatorTwoList = await operatorTwoListResponse.json() as {
    items: Array<{ id: string }>;
  };
  assert.deepEqual(operatorTwoList.items.map((item) => item.id), [operatorTwoThread.id]);

  const crossUserMarkRead = await app.request(
    `/api/threadmark-ai/threads/${operatorOneThread.id}/read`,
    { method: "POST", headers: { cookie: operatorTwoCookie } },
  );
  assert.equal(crossUserMarkRead.status, 404);

  const ownMarkRead = await app.request(
    `/api/threadmark-ai/threads/${operatorOneThread.id}/read`,
    { method: "POST", headers: { cookie: operatorOneCookie } },
  );
  assert.equal(ownMarkRead.status, 200);
  assert.equal((await ownMarkRead.json() as ThreadmarkAiThreadDto).unread, false);

  const crossUserRead = await app.request(
    `/api/threadmark-ai/threads/${operatorOneThread.id}`,
    { headers: { cookie: operatorTwoCookie } },
  );
  assert.equal(crossUserRead.status, 404);
  const crossUserWrite = await app.request(
    `/api/threadmark-ai/threads/${operatorOneThread.id}/messages`,
    {
      method: "POST",
      headers: { cookie: operatorTwoCookie, "content-type": "application/json" },
      body: JSON.stringify({ body: "Esta mensagem não pode entrar na sala." }),
    },
  );
  assert.equal(crossUserWrite.status, 404);
  const legacyRouteRead = await app.request(
    `/api/investigation-threads/${operatorOneThread.id}`,
    { headers: { cookie: operatorTwoCookie } },
  );
  assert.equal(legacyRouteRead.status, 404);

  const owners = current.database
    .prepare(
      `SELECT id, created_by_user_id
       FROM investigation_threads WHERE scope = 'workspace' ORDER BY id`,
    )
    .all() as Array<{ id: string; created_by_user_id: string | null }>;
  assert.deepEqual(
    new Map(owners.map((thread) => [thread.id, thread.created_by_user_id])),
    new Map([
      [operatorOneThread.id, operatorOne.user.id],
      [operatorTwoThread.id, operatorTwo.user.id],
    ]),
  );

  const deleteOwn = await app.request(
    `/api/threadmark-ai/threads/${operatorTwoThread.id}`,
    { method: "DELETE", headers: { cookie: operatorTwoCookie } },
  );
  assert.equal(deleteOwn.status, 200);
  assert.deepEqual(await deleteOwn.json(), {
    id: operatorTwoThread.id,
    deleted: true,
  });
  const deletedRead = await app.request(
    `/api/threadmark-ai/threads/${operatorTwoThread.id}`,
    { headers: { cookie: operatorTwoCookie } },
  );
  assert.equal(deletedRead.status, 404);
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

    const activeDelete = await current.app.request(
      `/api/threadmark-ai/threads/${thread.id}`,
      { method: "DELETE" },
    );
    assert.equal(activeDelete.status, 409);
    const cancelled = await current.app.request(
      `/api/threadmark-ai/threads/${thread.id}/cancel`,
      { method: "POST" },
    );
    assert.equal(cancelled.status, 200);
    const deleted = await current.app.request(
      `/api/threadmark-ai/threads/${thread.id}`,
      { method: "DELETE" },
    );
    assert.equal(deleted.status, 200);
    await assert.rejects(
      readFile(persisted.local_path),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    );
    assert.deepEqual(
      current.database
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM investigation_threads WHERE id = ?) AS threads,
             (SELECT COUNT(*) FROM investigation_thread_messages WHERE thread_id = ?) AS messages,
             (SELECT COUNT(*) FROM investigation_thread_jobs WHERE thread_id = ?) AS jobs,
             (SELECT COUNT(*) FROM investigation_thread_message_attachments WHERE id = ?) AS attachments`,
        )
        .get(thread.id, thread.id, thread.id, attachment.id),
      { threads: 0, messages: 0, jobs: 0, attachments: 0 },
    );
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
