import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LocalAuthService, SetupChallengeService } from "../server/auth/index.js";
import { createDatabase } from "../server/db/index.js";
import { SupportStore } from "../server/domain/index.js";
import { createApiApp, createTestApiApp } from "../server/index.js";
import { LocalSecretVault } from "../server/runtime/secret-vault.js";
import {
  LocalToolService,
  LocalToolSettingsError,
} from "../server/tools/local-tool-service.js";

const OWNER_TEST_PASSWORD = "owner test password";
const VIEWER_TEST_PASSWORD = "viewer test password";

test("registro de tools persiste escopo profundo e mantém credenciais fora do SQLite e da API", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadmark-local-tools-"));
  const databasePath = path.join(root, "threadmark.sqlite");
  const database = createDatabase(databasePath);
  const service = new LocalToolService(
    database,
    new LocalSecretVault(path.join(root, "secrets")),
  );
  try {
    const created = await service.create(
      {
        type: "postgres_readonly",
        name: "Banco de produção readonly",
        deepEnabled: true,
        allowedOperations: ["describe_schema", "query_readonly"],
        config: {
          host: "postgres.internal",
          port: 5432,
          database: "support",
          username: "threadmark_readonly",
          sslMode: "verify-full",
        },
        secrets: { password: "segredo-que-nao-pode-vazar" },
      },
      "Admin",
    );

    assert.deepEqual(created.secretFields, ["password"]);
    assert.equal(JSON.stringify(created).includes("segredo-que"), false);
    assert.deepEqual(service.listEnabledForDeep().map((tool) => tool.id), [created.id]);
    const resolved = await service.getSecretConfig(created.id);
    assert.equal(
      (resolved.secrets as { password?: string }).password,
      "segredo-que-nao-pode-vazar",
    );

    const row = database
      .prepare("SELECT config_json, secret_fields_json FROM local_tools WHERE id = ?")
      .get(created.id) as { config_json: string; secret_fields_json: string };
    assert.equal(JSON.stringify(row).includes("segredo-que"), false);
    database.pragma("wal_checkpoint(TRUNCATE)");
    assert.equal((await readFile(databasePath)).includes(Buffer.from("segredo-que")), false);

    const app = createTestApiApp(new SupportStore(database), undefined, undefined, {
      tools: service,
    });
    const listResponse = await app.request("/api/tools");
    assert.equal(listResponse.status, 200);
    assert.equal((await listResponse.text()).includes("segredo-que"), false);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("tools aceitam apenas operações readonly previstas para o tipo", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadmark-tool-policy-"));
  const database = createDatabase(":memory:");
  const service = new LocalToolService(
    database,
    new LocalSecretVault(path.join(root, "secrets")),
  );
  try {
    await assert.rejects(
      service.create(
        {
          type: "codebase",
          name: "Código",
          config: { rootPath: root },
          allowedOperations: ["query_readonly"],
        },
        "Admin",
      ),
      (error: unknown) =>
        error instanceof LocalToolSettingsError && /não é permitida/.test(error.message),
    );
    await assert.rejects(
      service.create(
        {
          type: "codebase",
          name: "Sem capacidade",
          config: { rootPath: root },
          allowedOperations: [],
          deepEnabled: true,
        },
        "Admin",
      ),
      /pelo menos uma operação/,
    );
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("falha ao remover credencial preserva o registro da tool", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadmark-tool-delete-"));
  class DeleteFailingVault extends LocalSecretVault {
    override async delete(): Promise<boolean> {
      throw new Error("falha simulada no cofre");
    }
  }
  const database = createDatabase(":memory:");
  const service = new LocalToolService(
    database,
    new DeleteFailingVault(path.join(root, "secrets")),
  );
  try {
    const tool = await service.create({
      type: "vercel",
      name: "Vercel readonly",
      config: { teamId: null, projectId: "project_1" },
      secrets: { token: "token-local" },
    }, "Admin");

    await assert.rejects(service.delete(tool.id), /falha simulada/);
    assert.equal(service.get(tool.id).id, tool.id);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("teste seguro valida filesystem sem executar integrações externas", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadmark-tool-test-"));
  const skillDirectory = path.join(root, "debugger");
  await writeFile(path.join(root, "knowledge.md"), "conteúdo");
  await mkdir(skillDirectory);
  await writeFile(path.join(skillDirectory, "SKILL.md"), "# Debugger\n");
  const database = createDatabase(":memory:");
  const service = new LocalToolService(
    database,
    new LocalSecretVault(path.join(root, "secrets")),
  );
  try {
    const skill = await service.create(
      {
        type: "debugger_skill",
        name: "Debugger do time",
        config: { skillPath: skillDirectory },
      },
      "Admin",
    );
    assert.deepEqual(await service.test(skill.id), {
      ok: true,
      message: "Skill acessível em modo somente leitura.",
      checkedAt: service.get(skill.id).lastTestedAt,
      mode: "filesystem",
    });

    const missing = await service.create(
      {
        type: "knowledge",
        name: "Base ausente",
        config: { rootPath: path.join(root, "nao-existe") },
      },
      "Admin",
    );
    const failed = await service.test(missing.id);
    assert.equal(failed.ok, false);
    assert.match(failed.message, /não existe/);
    assert.equal(service.get(missing.id).lastTestStatus, "failed");
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("API gerencia tools locais sem retornar segredos e exclusão remove o cofre", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadmark-tools-api-"));
  const database = createDatabase(":memory:");
  const vault = new LocalSecretVault(path.join(root, "secrets"));
  const service = new LocalToolService(database, vault);
  const app = createTestApiApp(new SupportStore(database), undefined, undefined, {
    tools: service,
    toolTester: {
      async test(toolId) {
        const result = {
          ok: true as const,
          message: "Conexão Vercel readonly validada.",
          checkedAt: new Date().toISOString(),
          mode: "connection" as const,
        };
        service.recordTestResult(toolId, result);
        return result;
      },
    },
  });
  try {
    const createdResponse = await app.request("/api/tools", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "vercel",
        name: "Vercel readonly",
        config: { teamId: "team_1", projectId: "project_1" },
        secrets: { token: "vercel-token-confidencial" },
      }),
    });
    assert.equal(createdResponse.status, 201);
    const createdText = await createdResponse.text();
    assert.equal(createdText.includes("vercel-token-confidencial"), false);
    const created = JSON.parse(createdText) as { id: string; deepEnabled: boolean };
    assert.equal(created.deepEnabled, true);

    const tested = await app.request(`/api/tools/${created.id}/test`, {
      method: "POST",
    });
    assert.equal(tested.status, 200);
    assert.deepEqual(
      await tested.json(),
      {
        ok: true,
        message: "Conexão Vercel readonly validada.",
        checkedAt: service.get(created.id).lastTestedAt,
        mode: "connection",
      },
    );

    const disabled = await app.request(`/api/tools/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false, deepEnabled: false }),
    });
    assert.equal(disabled.status, 200);
    assert.equal(service.listEnabledForDeep().length, 0);
    await assert.rejects(
      service.getSecretConfig(created.id),
      /não está ativa para investigação aprofundada/,
    );

    const deleted = await app.request(`/api/tools/${created.id}`, {
      method: "DELETE",
    });
    assert.equal(deleted.status, 200);
    assert.equal(await vault.get(`local-tool:${created.id}`), null);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("API restringe leitura e mutação de tools a owner e admin", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadmark-tools-roles-"));
  const database = createDatabase(":memory:");
  const auth = new LocalAuthService(database);
  const challenges = new SetupChallengeService(database);
  const service = new LocalToolService(
    database,
    new LocalSecretVault(path.join(root, "secrets")),
  );
  const app = createApiApp(new SupportStore(database), undefined, undefined, {
    auth,
    setupChallenges: challenges,
    tools: service,
  });
  try {
    const challenge = challenges.issue();
    const setup = await app.request("/api/setup/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bootstrapToken: challenge.token,
        workspaceName: "Suporte",
        organizationName: "Empresa",
        timezone: "America/Sao_Paulo",
        login: "owner",
        displayName: "Owner",
        password: OWNER_TEST_PASSWORD,
      }),
    });
    const ownerCookie = setup.headers.get("set-cookie")?.split(";")[0];
    assert.ok(ownerCookie);
    const viewer = await app.request("/api/users", {
      method: "POST",
      headers: { cookie: ownerCookie, "content-type": "application/json" },
      body: JSON.stringify({
        username: "viewer",
        displayName: "Viewer",
        role: "viewer",
        password: VIEWER_TEST_PASSWORD,
      }),
    });
    assert.equal(viewer.status, 201);
    const login = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "viewer", password: VIEWER_TEST_PASSWORD }),
    });
    const viewerCookie = login.headers.get("set-cookie")?.split(";")[0];
    assert.ok(viewerCookie);

    const [viewerList, viewerCreate, ownerList] = await Promise.all([
      app.request("/api/tools", { headers: { cookie: viewerCookie } }),
      app.request("/api/tools", {
        method: "POST",
        headers: { cookie: viewerCookie, "content-type": "application/json" },
        body: JSON.stringify({
          type: "codebase",
          name: "Sem permissão",
          config: { rootPath: root },
        }),
      }),
      app.request("/api/tools", { headers: { cookie: ownerCookie } }),
    ]);
    assert.equal(viewerList.status, 403);
    assert.equal(viewerCreate.status, 403);
    assert.equal(ownerList.status, 200);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
