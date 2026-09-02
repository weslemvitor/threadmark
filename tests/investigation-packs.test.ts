import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  InvestigationPackError,
  InvestigationPackService,
} from "../server/agent/investigation-pack-service.js";
import { createDatabase } from "../server/db/index.js";
import { LocalSecretVault } from "../server/runtime/secret-vault.js";
import { LocalToolService } from "../server/tools/local-tool-service.js";

test("onboarding cria, testa e ativa um pack privado sem embutir o domínio no código", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "threadmark-pack-"));
  const database = createDatabase(":memory:");
  const tools = new LocalToolService(
    database,
    new LocalSecretVault(path.join(temporary, "secrets")),
  );
  const now = "2026-08-31T18:00:00.000Z";
  database.prepare(
    `INSERT INTO local_users (
       id, username, display_name, role, password_hash, active,
       failed_login_attempts, locked_until, last_login_at,
       password_changed_at, created_at, updated_at
     ) VALUES ('owner-1', 'owner', 'Pessoa proprietária', 'owner', 'hash', 1,
               0, NULL, NULL, ?, ?, ?)`,
  ).run(now, now, now);
  const root = path.join(temporary, "code");
  const codebase = await tools.create({
    type: "codebase",
    name: "Produto privado",
    config: { rootPath: root },
    allowedOperations: ["search_files", "read_files"],
  }, "Pessoa proprietária");
  const packs = new InvestigationPackService(database, tools, {
    async test(toolId) {
      const result = {
        ok: true,
        message: "Leitura validada.",
        checkedAt: now,
        mode: "filesystem" as const,
      };
      tools.recordTestResult(toolId, result);
      return result;
    },
  }, {
    async testConnection() {
      return { ok: true, message: "Modelo disponível.", models: ["default"] };
    },
  });

  try {
    assert.equal(packs.getActive(), null);
    const draft = packs.createDraft({
      name: "Operação privada",
      domain: "Suporte de uma plataforma fictícia",
      purpose: "Investigar falhas reais sem inventar causa.",
      goals: ["Explicar por que uma ação não foi processada."],
      selectedToolIds: [codebase.id],
      vocabulary: [{ term: "Execução", meaning: "Uma tentativa de processamento." }],
      investigationExamples: ["Por que a ação do cliente não foi processada?"],
      includeCustomerDraft: true,
    }, "owner-1");

    assert.equal(draft.status, "draft");
    assert.equal(draft.readiness.state, "needs_probe");
    assert.equal(draft.readiness.deepInvestigationEnabled, false);
    assert.deepEqual(draft.manifest.selectedToolIds, [codebase.id]);
    assert.equal(draft.manifest.playbooks[0]?.id, "root-cause-investigation");
    assert.ok(draft.manifest.playbooks[0]?.steps.some((step) =>
      step.toolTypes.includes("codebase") && step.operations.includes("search_files")
    ));

    const probed = await packs.probe(draft.id);
    assert.equal(probed.readiness.state, "ready");
    assert.equal(probed.readiness.deepInvestigationEnabled, true);

    const active = packs.activate(draft.id);
    assert.equal(active.status, "active");
    assert.equal(packs.getActive()?.id, draft.id);
    assert.doesNotMatch(JSON.stringify(active), /password|secret|token/iu);
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("pack não ativa enquanto ferramenta selecionada não foi validada", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "threadmark-pack-block-"));
  const database = createDatabase(":memory:");
  const tools = new LocalToolService(
    database,
    new LocalSecretVault(path.join(temporary, "secrets")),
  );
  const now = "2026-08-31T18:00:00.000Z";
  database.prepare(
    `INSERT INTO local_users (
       id, username, display_name, role, password_hash, active,
       failed_login_attempts, password_changed_at, created_at, updated_at
     ) VALUES ('owner-2', 'owner2', 'Outra pessoa', 'owner', 'hash', 1, 0, ?, ?, ?)`,
  ).run(now, now, now);
  const tool = await tools.create({
    type: "knowledge",
    name: "Conhecimento privado",
    config: { rootPath: path.join(temporary, "knowledge") },
  }, "Outra pessoa");
  const packs = new InvestigationPackService(database, tools);

  try {
    const draft = packs.createDraft({
      name: "Pack incompleto",
      domain: "Domínio fictício",
      purpose: "Testar o bloqueio técnico.",
      goals: ["Investigar casos."],
      selectedToolIds: [tool.id],
    }, "owner-2");
    assert.throws(
      () => packs.activate(draft.id),
      (error) =>
        error instanceof InvestigationPackError &&
        error.kind === "conflict" &&
        /teste do pack/i.test(error.message),
    );
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
