import assert from "node:assert/strict";
import test from "node:test";

import { createDatabase } from "../server/db/index.js";
import { SupportStore, ValidationError } from "../server/domain/index.js";

test("persistência aceita apenas categorias relacionadas ao atendimento", () => {
  const database = createDatabase(":memory:");
  const store = new SupportStore(database);

  try {
    const account = store.upsertAccount({
      phoneNumber: "+12025550120",
      displayName: "Conta comercial",
    });
    const client = store.upsertClient({
      name: "Cliente",
      slug: "cliente",
      kind: "ecommerce",
    });
    const group = store.upsertGroup({
      accountId: account.id,
      clientId: client.id,
      externalJid: "120363000001@g.us",
      subject: "Cliente",
    });
    const participant = store.upsertParticipant({
      externalJid: "12025550121@s.whatsapp.net",
      displayName: "Pessoa cliente",
    });
    const message = store.upsertMessage({
      externalId: "category-policy-message",
      groupId: group.id,
      senderId: participant.id,
      occurredAt: "2026-07-17T15:00:00.000Z",
      text: "Os dados do dashboard estão diferentes.",
      messageType: "text",
      triageKind: "demand",
    });
    const manualDashboard = store.upsertCategory({
      facet: "product",
      slug: "dashboard",
      label: "Dashboard",
    });
    const ticket = store.createTicket({
      groupId: group.id,
      sourceMessageId: message.id,
      title: "Dados divergentes",
      summary: "Cliente relata divergência no dashboard.",
      categories: [
        {
          categoryId: manualDashboard.id,
          source: "manual",
          confidence: 1,
        },
      ],
    });
    const job = store.queueInvestigation(ticket.id);

    const result = store.completeInvestigationJob(job.jobId, {
      createTicket: true,
      outcome: "technical_investigation_required",
      relation: "new",
      relatedTicketId: null,
      title: "Dados incorretos no dashboard",
      summary: "Os valores exibidos divergem.",
      affectedEcommerce: null,
      priority: "normal",
      categories: {
        contactReason: ["Dúvida", "WhatsApp", "Mensagem sem contexto"],
        productArea: ["Painel", "Nome da empresa", "Áudio sem transcrição"],
        platform: ["Google", "WhatsApp"],
        symptom: ["Dados divergentes", "PDF sem leitura"],
      },
      evidence: [],
      suggestedResponse: null,
      missingInformation: [],
      nextAction: "Conferir a regra da métrica em modo readonly.",
      confidence: 0.8,
    });

    assert.deepEqual(
      result.categories
        .map(({ facet, label }) => ({ facet, label }))
        .sort((left, right) => left.facet.localeCompare(right.facet)),
      [
        { facet: "platform", label: "Google Ads" },
        { facet: "product", label: "Dashboard" },
        { facet: "reason", label: "Dúvida" },
        { facet: "symptom", label: "Dados incorretos" },
      ],
    );

    const persisted = database
      .prepare("SELECT result_json FROM investigation_jobs WHERE id = ?")
      .get(job.jobId) as { result_json: string };
    assert.deepEqual(JSON.parse(persisted.result_json).categories, {
      contactReason: ["Dúvida"],
      productArea: ["Dashboard"],
      platform: ["Google Ads"],
      symptom: ["Dados incorretos"],
    });
    assert.deepEqual(
      database
        .prepare(
          `SELECT source, confidence
           FROM ticket_categories
           WHERE ticket_id = ? AND category_id = ?`,
        )
        .get(ticket.id, manualDashboard.id),
      { source: "manual", confidence: 1 },
      "uma investigação automática não pode rebaixar categoria manual para IA",
    );
    assert.equal(
      (
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM categories WHERE lower(label) IN ('whatsapp', 'nome da empresa', 'audio sem transcricao', 'pdf sem leitura')",
          )
          .get() as { count: number }
      ).count,
      0,
    );

    const rerun = store.queueInvestigation(ticket.id, "Reclassificar o problema");
    const reclassified = store.completeInvestigationJob(rerun.jobId, {
      createTicket: true,
      outcome: "technical_investigation_required",
      relation: "new",
      relatedTicketId: null,
      title: "Mensagens não enviadas no CRM",
      summary: "A campanha não realizou os envios esperados.",
      affectedEcommerce: null,
      priority: "normal",
      categories: {
        contactReason: ["Problema"],
        productArea: ["Campanhas"],
        platform: ["Meta"],
        symptom: ["Mensagens não enviadas"],
      },
      evidence: [],
      suggestedResponse: null,
      missingInformation: [],
      nextAction: "Validar a execução da campanha em modo readonly.",
      confidence: 0.85,
    });
    assert.deepEqual(
      reclassified.categories
        .map(({ facet, label }) => ({ facet, label }))
        .sort((left, right) => left.facet.localeCompare(right.facet)),
      [
        { facet: "platform", label: "Meta" },
        { facet: "product", label: "CRM" },
        { facet: "product", label: "Dashboard" },
        { facet: "reason", label: "Problema" },
        { facet: "symptom", label: "Mensagens não enviadas" },
      ],
    );
    assert.equal(
      (
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM categories WHERE label IN ('Dúvida', 'Google Ads', 'Dados incorretos')",
          )
          .get() as { count: number }
      ).count,
      0,
      "categorias substituídas pela análise mais recente não devem ficar órfãs",
    );

    assert.throws(
      () =>
        store.upsertCategory({
          facet: "platform",
          slug: "whatsapp",
          label: "WhatsApp",
        }),
      (error: unknown) =>
        error instanceof ValidationError &&
        /deve descrever o problema ou a área funcional/i.test(error.message),
    );
  } finally {
    database.close();
  }
});
