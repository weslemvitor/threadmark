import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDatabase } from "../server/db/index.js";
import { SupportStore } from "../server/domain/index.js";
import { LocalSecretVault } from "../server/runtime/secret-vault.js";
import { DeepToolExecutor } from "../server/tools/deep-tool-executor.js";
import { LocalToolService } from "../server/tools/local-tool-service.js";

const definition = {
  nodes: [
    {
      id: "trigger-ticket-created",
      type: "trigger" as const,
      name: "Ticket criado",
      config: { eventType: "ticket_created" },
    },
    {
      id: "add-internal-note",
      type: "internal_action" as const,
      name: "Registrar nota",
      config: {
        actionId: "add_internal_note",
        input: { body: "Triagem iniciada para o ticket #{{ticket.number}}" },
      },
    },
  ],
  edges: [
    {
      id: "edge-trigger-note",
      source: "trigger-ticket-created",
      target: "add-internal-note",
    },
  ],
};

test("Threadmark AI prepara, confirma, testa e gerencia automações com autorização explícita", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "threadmark-ai-automations-"));
  const database = createDatabase(":memory:");
  const store = new SupportStore(database);
  const timestamp = "2026-08-20T15:00:00.000Z";
  database.prepare(`
    INSERT INTO local_users (
      id, username, display_name, role, password_hash, active,
      password_changed_at, created_at, updated_at
    ) VALUES ('owner-1', 'owner-user', 'Pessoa Proprietária', 'owner', 'test-only', 1, ?, ?, ?)
  `).run(timestamp, timestamp, timestamp);
  const thread = store.createThreadmarkAiThread({}, "Pessoa Proprietária");
  const executor = new DeepToolExecutor(
    new LocalToolService(database, new LocalSecretVault(path.join(temporary, "secrets"))),
    { database, supportStore: store },
  );

  const addOperatorMessage = (body: string) => {
    database.prepare(`
      UPDATE investigation_thread_jobs
      SET state = 'completed', finished_at = requested_at, result_json = '{}'
      WHERE thread_id = ? AND state IN ('queued', 'running')
    `).run(thread.id);
    const updated = store.addThreadmarkAiMessage(
      thread.id,
      { body },
      [],
      false,
      { userId: "owner-1", role: "owner" },
    );
    const message = updated.messages.filter((item) => item.role === "operator").at(-1);
    assert.ok(message);
    return message;
  };

  try {
    const descriptor = executor.descriptors().find((item) => item.id === "threadmark-automations");
    assert.ok(descriptor);
    assert.deepEqual(descriptor.operations.map((operation) => operation.name), [
      "get_automation_capabilities",
      "list_automations",
      "get_automation",
      "test_automation",
      "prepare_automation_draft",
      "apply_automation_draft",
      "set_automation_status",
      "delete_automation",
    ]);

    const capabilities = await executor.execute({
      requestId: "automation-capabilities",
      toolId: "threadmark-automations",
      operation: "get_automation_capabilities",
      argumentsJson: "{}",
      purpose: "Usar apenas capacidades reais do workspace.",
    });
    assert.equal(capabilities.status, "success");
    assert.match(capabilities.content, /ticket_created/);
    assert.match(capabilities.content, /owner-1/);
    assert.doesNotMatch(capabilities.content, /sendMessage/);

    const directMessage = addOperatorMessage(
      "Crie uma automação para registrar uma nota quando o ticket for criado.",
    );
    const directPrepared = await executor.execute({
      requestId: "automation-direct-prepare",
      toolId: "threadmark-automations",
      operation: "prepare_automation_draft",
      argumentsJson: JSON.stringify({
        operatorMessageId: directMessage.id,
        automationId: null,
        name: "Teste de tarefa direta",
        description: "Valida autorização na mesma tarefa.",
        definition,
      }),
      purpose: "Preparar a automação explicitamente solicitada.",
    });
    assert.equal(directPrepared.status, "success");
    const directPreview = JSON.parse(directPrepared.content) as {
      draftId: string;
      executionAuthorized: boolean;
    };
    assert.equal(directPreview.executionAuthorized, true);
    const directApplied = await executor.execute({
      requestId: "automation-direct-apply",
      toolId: "threadmark-automations",
      operation: "apply_automation_draft",
      argumentsJson: JSON.stringify({
        confirmationMessageId: directMessage.id,
        draftId: directPreview.draftId,
      }),
      purpose: "Concluir a tarefa explicitamente autorizada sem confirmação duplicada.",
    });
    assert.equal(directApplied.status, "success", directApplied.summary);
    const directWorkflow = (JSON.parse(directApplied.content) as { workflow: { id: string } }).workflow;
    const directJob = store.claimNextAgentJob();
    assert.equal(directJob?.kind, "thread_turn");
    if (!directJob || directJob.kind !== "thread_turn") assert.fail("turno da automação não reivindicado");
    store.appendInvestigationThreadToolExecution(directJob.id, directApplied);
    const consumedRetryMessage = addOperatorMessage("Tenta novamente");
    const consumedRetry = await executor.execute({
      requestId: "automation-direct-consumed-retry",
      toolId: "threadmark-automations",
      operation: "apply_automation_draft",
      argumentsJson: JSON.stringify({
        confirmationMessageId: consumedRetryMessage.id,
        draftId: directPreview.draftId,
      }),
      purpose: "Comprovar que uma repetição não reutiliza autorização já consumida.",
    });
    assert.equal(consumedRetry.status, "error");
    const directDeleteMessage = addOperatorMessage("Exclua a automação de teste agora.");
    const directDeleted = await executor.execute({
      requestId: "automation-direct-delete",
      toolId: "threadmark-automations",
      operation: "delete_automation",
      argumentsJson: JSON.stringify({
        confirmationMessageId: directDeleteMessage.id,
        automationId: directWorkflow.id,
      }),
      purpose: "Limpar a automação criada no cenário isolado.",
    });
    assert.equal(directDeleted.status, "success");

    const requestMessage = addOperatorMessage("Prepare uma automação para registrar uma nota quando o ticket for criado.");
    const prepared = await executor.execute({
      requestId: "automation-prepare-create",
      toolId: "threadmark-automations",
      operation: "prepare_automation_draft",
      argumentsJson: JSON.stringify({
        operatorMessageId: requestMessage.id,
        automationId: null,
        name: "Registrar início da triagem",
        description: "Adiciona uma nota interna ao criar um ticket.",
        definition,
      }),
      purpose: "Preparar uma proposta sem alterar a automação real.",
    });
    assert.equal(prepared.status, "success");
    assert.match(prepared.summary, /não foi alterada/);
    assert.equal((database.prepare("SELECT COUNT(*) AS total FROM automation_workflows").get() as { total: number }).total, 0);
    const draftId = (JSON.parse(prepared.content) as { draftId: string }).draftId;

    const confirmation = addOperatorMessage("Confirmo: pode criar essa automação exatamente como está na proposta.");
    const applied = await executor.execute({
      requestId: "automation-apply-create",
      toolId: "threadmark-automations",
      operation: "apply_automation_draft",
      argumentsJson: JSON.stringify({ confirmationMessageId: confirmation.id, draftId }),
      purpose: "Aplicar a proposta confirmada em uma mensagem posterior.",
    });
    assert.equal(applied.status, "success");
    assert.match(applied.summary, /criada como rascunho/);
    const workflow = (JSON.parse(applied.content) as { workflow: { id: string; status: string } }).workflow;
    assert.equal(workflow.status, "draft");

    const dryRun = await executor.execute({
      requestId: "automation-dry-run",
      toolId: "threadmark-automations",
      operation: "test_automation",
      argumentsJson: JSON.stringify({ automationId: workflow.id }),
      purpose: "Validar sem executar ações.",
    });
    assert.equal(dryRun.status, "success");
    assert.match(dryRun.summary, /sem executar ações/);
    assert.equal((JSON.parse(dryRun.content) as { dryRun: boolean }).dryRun, true);
    assert.equal((database.prepare("SELECT COUNT(*) AS total FROM automation_runs").get() as { total: number }).total, 0);

    const activateMessage = addOperatorMessage("Ative essa automação agora.");
    const activated = await executor.execute({
      requestId: "automation-activate",
      toolId: "threadmark-automations",
      operation: "set_automation_status",
      argumentsJson: JSON.stringify({
        confirmationMessageId: activateMessage.id,
        automationId: workflow.id,
        status: "active",
      }),
      purpose: "Ativar somente após pedido explícito.",
    });
    assert.equal(activated.status, "success");
    assert.equal((JSON.parse(activated.content) as { status: string }).status, "active");

    const vagueMessage = addOperatorMessage("O fluxo parece interessante.");
    const deniedPause = await executor.execute({
      requestId: "automation-vague-pause",
      toolId: "threadmark-automations",
      operation: "set_automation_status",
      argumentsJson: JSON.stringify({
        confirmationMessageId: vagueMessage.id,
        automationId: workflow.id,
        status: "paused",
      }),
      purpose: "Não deve interpretar comentário como autorização.",
    });
    assert.equal(deniedPause.status, "error");
    assert.match(deniedPause.summary, /não confirma explicitamente/);
    assert.equal((database.prepare("SELECT status FROM automation_workflows WHERE id = ?").get(workflow.id) as { status: string }).status, "active");

    const pauseMessage = addOperatorMessage("Pause essa automação agora.");
    const paused = await executor.execute({
      requestId: "automation-pause",
      toolId: "threadmark-automations",
      operation: "set_automation_status",
      argumentsJson: JSON.stringify({
        confirmationMessageId: pauseMessage.id,
        automationId: workflow.id,
        status: "paused",
      }),
      purpose: "Pausar após solicitação explícita.",
    });
    assert.equal(paused.status, "success");
    assert.equal((JSON.parse(paused.content) as { status: string }).status, "paused");

    const editMessage = addOperatorMessage("Prepare a edição do nome da automação, mantendo o mesmo fluxo.");
    const editPrepared = await executor.execute({
      requestId: "automation-prepare-edit",
      toolId: "threadmark-automations",
      operation: "prepare_automation_draft",
      argumentsJson: JSON.stringify({
        operatorMessageId: editMessage.id,
        automationId: workflow.id,
        name: "Registrar início do atendimento",
        description: "Adiciona uma nota interna ao criar um ticket.",
        definition,
      }),
      purpose: "Preparar edição sem alterar o fluxo atual.",
    });
    assert.equal(editPrepared.status, "success");
    assert.match(editPrepared.summary, /edição/);
    assert.equal(
      (database.prepare("SELECT name FROM automation_workflows WHERE id = ?").get(workflow.id) as { name: string }).name,
      "Registrar início da triagem",
    );
    const editDraftId = (JSON.parse(editPrepared.content) as { draftId: string }).draftId;
    const editConfirmation = addOperatorMessage("Confirmo: pode aplicar a proposta de edição da automação.");
    const edited = await executor.execute({
      requestId: "automation-apply-edit",
      toolId: "threadmark-automations",
      operation: "apply_automation_draft",
      argumentsJson: JSON.stringify({
        confirmationMessageId: editConfirmation.id,
        draftId: editDraftId,
      }),
      purpose: "Aplicar a edição confirmada.",
    });
    assert.equal(
      edited.status,
      "success",
      `${edited.summary}\n${edited.content}`,
    );
    assert.match(edited.summary, /atualizada/);
    assert.equal(
      (database.prepare("SELECT name, status FROM automation_workflows WHERE id = ?").get(workflow.id) as { name: string; status: string }).name,
      "Registrar início do atendimento",
    );

    const deleteMessage = addOperatorMessage("Exclua essa automação definitivamente.");
    const deleted = await executor.execute({
      requestId: "automation-delete",
      toolId: "threadmark-automations",
      operation: "delete_automation",
      argumentsJson: JSON.stringify({
        confirmationMessageId: deleteMessage.id,
        automationId: workflow.id,
      }),
      purpose: "Excluir após confirmação explícita.",
    });
    assert.equal(deleted.status, "success");
    assert.match(deleted.summary, /excluída definitivamente/);
    assert.equal((database.prepare("SELECT COUNT(*) AS total FROM automation_workflows WHERE id = ?").get(workflow.id) as { total: number }).total, 0);
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("Threadmark AI bloqueia alterações de automação para operador sem privilégio", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "threadmark-ai-automation-role-"));
  const database = createDatabase(":memory:");
  const store = new SupportStore(database);
  const timestamp = "2026-08-20T15:00:00.000Z";
  database.prepare(`
    INSERT INTO local_users (
      id, username, display_name, role, password_hash, active,
      password_changed_at, created_at, updated_at
    ) VALUES ('operator-1', 'operator-user', 'Pessoa Operadora', 'operator', 'test-only', 1, ?, ?, ?)
  `).run(timestamp, timestamp, timestamp);
  const thread = store.createThreadmarkAiThread({}, "Pessoa Operadora");
  const updated = store.addThreadmarkAiMessage(
    thread.id,
    { body: "Crie uma automação para mim." },
    [],
    false,
    { userId: "operator-1", role: "operator" },
  );
  const message = updated.messages.find((item) => item.role === "operator");
  assert.ok(message);
  const executor = new DeepToolExecutor(
    new LocalToolService(database, new LocalSecretVault(path.join(temporary, "secrets"))),
    { database, supportStore: store },
  );

  try {
    const result = await executor.execute({
      requestId: "automation-denied-role",
      toolId: "threadmark-automations",
      operation: "prepare_automation_draft",
      argumentsJson: JSON.stringify({
        operatorMessageId: message.id,
        automationId: null,
        name: "Não autorizada",
        description: null,
        definition,
      }),
      purpose: "Confirmar a fronteira de autorização.",
    });
    assert.equal(result.status, "error");
    assert.match(result.summary, /Somente proprietário ou administrador/);
    assert.equal((database.prepare("SELECT COUNT(*) AS total FROM automation_workflows").get() as { total: number }).total, 0);
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
