import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AiProviderSettingsService,
  extractCodexModelIds,
} from "../server/agent/provider-settings.js";
import { createDatabase } from "../server/db/index.js";
import { SupportStore } from "../server/domain/index.js";
import { createTestApiApp } from "../server/index.js";
import { LocalSecretVault } from "../server/runtime/secret-vault.js";

test("configurações de IA persistem metadados no SQLite e segredo cifrado fora dele", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadmark-provider-settings-"));
  const databasePath = path.join(root, "threadmark.sqlite");
  const database = createDatabase(databasePath);
  try {
    const service = new AiProviderSettingsService(
      database,
      new LocalSecretVault(path.join(root, "secrets")),
    );
    const initialProfiles = service.getProfiles();
    assert.deepEqual(
      initialProfiles.map((profile) => ({
          taskKind: profile.taskKind,
          connectionId: profile.connectionId,
          enabled: profile.enabled,
        })),
      [
        { taskKind: "triage", connectionId: "builtin-codex", enabled: true },
        { taskKind: "automatic", connectionId: "builtin-codex", enabled: true },
        { taskKind: "deep", connectionId: "builtin-codex", enabled: true },
        { taskKind: "documentation", connectionId: "builtin-codex", enabled: true },
      ],
    );
    service.updateProfiles(
      [{
        taskKind: "automatic",
        connectionId: "builtin-codex",
        model: "codex-automatic-model",
        enabled: true,
      }],
      "Admin",
    );
    const codexAgent = await service.createAgentForTask(
      "automatic",
      {} as never,
    );
    assert.equal(codexAgent.profile.model, "codex-automatic-model");
    const fakeSecret = "chave-ficticia-do-provedor-teste";
    const connection = await service.createConnection(
      {
        label: "OpenAI do time",
        providerId: "openai",
        apiKey: fakeSecret,
      },
      "Admin",
    );
    assert.equal(connection.hasSecret, true);
    assert.equal(connection.secretLastFour, "este");
    assert.equal(JSON.stringify(service.listConnections()).includes(fakeSecret), false);
    assert.equal((await readFile(databasePath)).includes(Buffer.from(fakeSecret)), false);

    const profiles = service.updateProfiles(
      [{
        taskKind: "automatic",
        connectionId: connection.id,
        model: "modelo-economico",
        enabled: true,
      }],
      "Admin",
    );
    assert.equal(
      profiles.find((profile) => profile.taskKind === "automatic")?.connectionId,
      connection.id,
    );

    const ollama = await service.createConnection(
      {
        label: "Ollama local",
        providerId: "ollama",
        baseUrl: "http://127.0.0.1:11434/api",
      },
      "Admin",
    );
    const deepProfiles = service.updateProfiles(
      [{ taskKind: "deep", connectionId: ollama.id, model: "local", enabled: true }],
      "Admin",
    );
    assert.equal(
      deepProfiles.find((profile) => profile.taskKind === "deep")?.connectionId,
      ollama.id,
    );
    await assert.rejects(
      service.createConnection(
        {
          label: "Ollama remoto",
          providerId: "ollama",
          baseUrl: "https://example.com/api",
        },
        "Admin",
      ),
      /endereço local/,
    );
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("catálogo do Codex expõe apenas modelos selecionáveis e mantém o padrão", () => {
  assert.deepEqual(
    extractCodexModelIds({
      models: [
        { slug: "modelo-b", visibility: "list" },
        { slug: "modelo-oculto", visibility: "hide" },
        { slug: "modelo-a", visibility: "list" },
        { slug: "modelo-a", visibility: "list" },
      ],
    }),
    ["default", "modelo-b", "modelo-a"],
  );
  assert.deepEqual(extractCodexModelIds(null), ["default"]);
});

test("conexões em uso não são pausadas e exclusão desativa perfis dependentes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadmark-provider-profile-"));
  const database = createDatabase(":memory:");
  try {
    const service = new AiProviderSettingsService(
      database,
      new LocalSecretVault(path.join(root, "secrets")),
    );
    const connection = await service.createConnection(
      {
        label: "Modelo local",
        providerId: "ollama",
        baseUrl: "http://127.0.0.1:11434/api",
      },
      "Admin",
    );
    service.updateProfiles(
      [{
        taskKind: "automatic",
        connectionId: connection.id,
        model: "modelo-local",
        enabled: true,
      }],
      "Admin",
    );

    await assert.rejects(
      service.updateConnection(connection.id, { enabled: false }, "Admin"),
      /perfis que usam esta conexão/,
    );
    await service.deleteConnection(connection.id);
    const profile = service
      .getProfiles()
      .find((item) => item.taskKind === "automatic");
    assert.equal(profile?.connectionId, null);
    assert.equal(profile?.enabled, false);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("API devolve erros úteis de configuração de IA sem expor erro interno", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadmark-provider-api-"));
  const database = createDatabase(":memory:");
  try {
    const service = new AiProviderSettingsService(
      database,
      new LocalSecretVault(path.join(root, "secrets")),
    );
    const app = createTestApiApp(
      new SupportStore(database),
      undefined,
      undefined,
      { aiSettings: service },
    );
    const response = await app.request("/api/ai/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: "Ollama remoto",
        providerId: "ollama",
        baseUrl: "https://example.com/api",
      }),
    });
    const payload = (await response.json()) as {
      error: { code: string; message: string };
    };

    assert.equal(response.status, 400);
    assert.equal(payload.error.code, "ai_invalid");
    assert.match(payload.error.message, /endereço local/);
    assert.doesNotMatch(payload.error.message, /Erro interno/);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("API persiste conexão e modelo independentes por tarefa e sincroniza a triagem", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadmark-provider-profiles-api-"));
  const database = createDatabase(":memory:");
  try {
    const service = new AiProviderSettingsService(
      database,
      new LocalSecretVault(path.join(root, "secrets")),
    );
    const app = createTestApiApp(
      new SupportStore(database),
      undefined,
      undefined,
      { aiSettings: service },
    );

    const response = await app.request("/api/ai/task-profiles", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: [
          {
            taskKind: "triage",
            connectionId: "builtin-codex",
            model: "gpt-5.4-mini",
            enabled: true,
          },
          {
            taskKind: "automatic",
            connectionId: "builtin-codex",
            model: "gpt-5.4",
            enabled: true,
          },
          {
            taskKind: "deep",
            connectionId: "builtin-codex",
            model: "default",
            enabled: true,
          },
        ],
      }),
    });
    assert.equal(response.status, 200);

    const triageResponse = await app.request("/api/triage/settings");
    assert.equal(triageResponse.status, 200);
    const triage = (await triageResponse.json()) as {
      enabled: boolean;
      model: string;
      connectionId: string | null;
      connectionLabel: string | null;
      providerId: string | null;
    };
    assert.equal(triage.enabled, true);
    assert.equal(triage.model, "gpt-5.4-mini");
    assert.equal(triage.connectionId, "builtin-codex");
    assert.equal(triage.connectionLabel, "Codex CLI");
    assert.equal(triage.providerId, "codex");

    assert.deepEqual(
      database
        .prepare(
          "SELECT enabled, model FROM triage_ai_settings WHERE singleton = 1",
        )
        .get(),
      { enabled: 1, model: "gpt-5.4-mini" },
    );
    assert.deepEqual(
      service.getProfiles().map(({ taskKind, model }) => ({ taskKind, model })),
      [
        { taskKind: "triage", model: "gpt-5.4-mini" },
        { taskKind: "automatic", model: "gpt-5.4" },
        { taskKind: "deep", model: "default" },
        { taskKind: "documentation", model: "default" },
      ],
    );
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
