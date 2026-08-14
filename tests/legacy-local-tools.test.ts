import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LocalAuthService, SetupChallengeService } from "../server/auth/index.js";
import { createDatabase } from "../server/db/index.js";
import { SupportStore } from "../server/domain/index.js";
import { createApiApp } from "../server/index.js";
import { LocalSecretVault } from "../server/runtime/secret-vault.js";
import { LegacyLocalToolImportService } from "../server/tools/legacy-tool-import.js";
import {
  LocalToolService,
  LocalToolSettingsError,
} from "../server/tools/local-tool-service.js";

const OWNER_TEST_PASSWORD = "owner test password";
const VIEWER_TEST_PASSWORD = "viewer test password";

test("instalação sem fontes legadas não inventa candidatos", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadmark-legacy-empty-"));
  const database = createDatabase(":memory:");
  const tools = new LocalToolService(
    database,
    new LocalSecretVault(path.join(root, "secrets")),
  );
  try {
    const legacy = new LegacyLocalToolImportService(tools, {
      codeRoots: [],
      vaultDirectory: null,
    });

    assert.deepEqual(await legacy.listCandidates(), []);
    assert.deepEqual(tools.list(), []);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("fontes legadas são revisadas, importadas explicitamente e não duplicam", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadmark-legacy-import-"));
  const codeRoot = path.join(root, "Produto");
  const vaultRoot = path.join(root, "Conhecimento");
  await Promise.all([
    mkdir(codeRoot, { recursive: true }),
    mkdir(vaultRoot, { recursive: true }),
  ]);
  const database = createDatabase(":memory:");
  const tools = new LocalToolService(
    database,
    new LocalSecretVault(path.join(root, "secrets")),
  );
  try {
    const legacy = new LegacyLocalToolImportService(tools, {
      codeRoots: [codeRoot, codeRoot],
      vaultDirectory: vaultRoot,
    });
    const candidates = await legacy.listCandidates();

    assert.equal(candidates.length, 2);
    assert.deepEqual(
      candidates.map((candidate) => candidate.status),
      ["ready", "ready"],
    );
    assert.deepEqual(
      new Set(candidates.map((candidate) => candidate.type)),
      new Set(["codebase", "knowledge"]),
    );
    assert.equal(tools.list().length, 0, "descobrir nunca autoriza automaticamente");

    const first = await legacy.importCandidates(
      candidates.map((candidate) => candidate.id),
      "Owner local",
    );
    assert.equal(first.importedCount, 2);
    assert.equal(first.alreadyImportedCount, 0);
    assert.equal(tools.list().length, 2);

    const afterImport = await legacy.listCandidates();
    assert.deepEqual(
      afterImport.map((candidate) => candidate.status),
      ["already_imported", "already_imported"],
    );
    assert.ok(afterImport.every((candidate) => candidate.existingToolId));

    const second = await legacy.importCandidates(
      candidates.map((candidate) => candidate.id),
      "Owner local",
    );
    assert.equal(second.importedCount, 0);
    assert.equal(second.alreadyImportedCount, 2);
    assert.equal(tools.list().length, 2);

    const provenance = database
      .prepare(
        `SELECT COUNT(*) AS count, COUNT(DISTINCT legacy_source_ref) AS unique_count
         FROM local_tools WHERE legacy_source_ref IS NOT NULL`,
      )
      .get() as { count: number; unique_count: number };
    assert.deepEqual(provenance, { count: 2, unique_count: 2 });
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("caminho legado inválido fica indisponível e não pode ser importado", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadmark-legacy-invalid-"));
  const database = createDatabase(":memory:");
  const tools = new LocalToolService(
    database,
    new LocalSecretVault(path.join(root, "secrets")),
  );
  try {
    const legacy = new LegacyLocalToolImportService(tools, {
      codeRoots: [path.join(root, "nao-existe")],
      vaultDirectory: null,
    });
    const [candidate] = await legacy.listCandidates();

    assert.equal(candidate?.status, "unavailable");
    assert.match(candidate?.statusMessage ?? "", /não existe|indisponível/i);
    await assert.rejects(
      legacy.importCandidates([candidate!.id], "Owner local"),
      (error: unknown) =>
        error instanceof LocalToolSettingsError && error.kind === "conflict",
    );
    assert.equal(tools.list().length, 0);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("API de recuperação legada exige owner ou admin", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadmark-legacy-acl-"));
  const codeRoot = path.join(root, "Produto");
  await mkdir(codeRoot, { recursive: true });
  const database = createDatabase(":memory:");
  const auth = new LocalAuthService(database);
  const challenges = new SetupChallengeService(database);
  const tools = new LocalToolService(
    database,
    new LocalSecretVault(path.join(root, "secrets")),
  );
  const legacyTools = new LegacyLocalToolImportService(tools, {
    codeRoots: [codeRoot],
    vaultDirectory: null,
  });
  const app = createApiApp(new SupportStore(database), undefined, undefined, {
    auth,
    setupChallenges: challenges,
    tools,
    legacyTools,
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
      body: JSON.stringify({
        username: "viewer",
        password: VIEWER_TEST_PASSWORD,
      }),
    });
    const viewerCookie = login.headers.get("set-cookie")?.split(";")[0];
    assert.ok(viewerCookie);

    const ownerCandidatesResponse = await app.request(
      "/api/tools/legacy-candidates",
      { headers: { cookie: ownerCookie } },
    );
    assert.equal(ownerCandidatesResponse.status, 200);
    const ownerPayload = await ownerCandidatesResponse.json() as {
      items: Array<{ id: string }>;
    };
    assert.equal(ownerPayload.items.length, 1);

    const [viewerList, viewerImport, ownerImport] = await Promise.all([
      app.request("/api/tools/legacy-candidates", {
        headers: { cookie: viewerCookie },
      }),
      app.request("/api/tools/legacy-import", {
        method: "POST",
        headers: { cookie: viewerCookie, "content-type": "application/json" },
        body: JSON.stringify({ candidateIds: [ownerPayload.items[0]!.id] }),
      }),
      app.request("/api/tools/legacy-import", {
        method: "POST",
        headers: { cookie: ownerCookie, "content-type": "application/json" },
        body: JSON.stringify({ candidateIds: [ownerPayload.items[0]!.id] }),
      }),
    ]);
    assert.equal(viewerList.status, 403);
    assert.equal(viewerImport.status, 403);
    assert.equal(ownerImport.status, 200);
    assert.equal(tools.list().length, 1);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
