import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { LocalAuthService } from "../server/auth/index.js";
import { createDatabase, type SupportDatabase } from "../server/db/index.js";
import { SupportStore } from "../server/domain/index.js";
import { createApiApp, createTestApiApp } from "../server/index.js";
import type {
  ApiErrorResponse,
  DirectoryRecordDto,
  DirectoryRecordTypeDto,
  DirectorySnapshotDto,
} from "../shared/contracts.js";

const databases: SupportDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function testApiFixture() {
  const database = createDatabase(":memory:");
  databases.push(database);
  const store = new SupportStore(database);
  return { database, app: createTestApiApp(store), store };
}

function jsonRequest(method: string, body: unknown, cookie?: string) {
  return {
    method,
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  };
}

test("API do Diretório rejeita payloads frouxos e retorna erros de domínio estáveis", async () => {
  const { app } = testApiFixture();
  const initialResponse = await app.request("/api/directory");
  assert.equal(initialResponse.status, 200);
  const initial = (await initialResponse.json()) as DirectorySnapshotDto;
  const organization = initial.recordTypes.find(
    (recordType) => recordType.slug === "organizacao",
  );
  assert.ok(organization);

  const extraProperty = await app.request(
    "/api/directory/types",
    jsonRequest("POST", {
      name: "Unidade",
      pluralName: "Unidades",
      kind: "ecommerce",
    }),
  );
  assert.equal(extraProperty.status, 400);
  assert.equal(
    ((await extraProperty.json()) as ApiErrorResponse).error.code,
    "validation_error",
  );

  const createdTypeResponse = await app.request(
    "/api/directory/types",
    jsonRequest("POST", {
      name: "Unidade",
      pluralName: "Unidades",
      slug: "unidade",
      description: null,
    }),
  );
  assert.equal(createdTypeResponse.status, 201);
  const createdType = (await createdTypeResponse.json()) as DirectoryRecordTypeDto;

  const duplicate = await app.request(
    "/api/directory/types",
    jsonRequest("POST", {
      name: "Outra unidade",
      pluralName: "Outras unidades",
      slug: createdType.slug,
    }),
  );
  assert.equal(duplicate.status, 409);
  assert.equal(
    ((await duplicate.json()) as ApiErrorResponse).error.code,
    "conflict",
  );

  const fieldResponse = await app.request(
    "/api/directory/fields",
    jsonRequest("POST", {
      recordTypeId: createdType.id,
      label: "Pontuação",
      type: "number",
    }),
  );
  assert.equal(fieldResponse.status, 201);
  const field = (await fieldResponse.json()) as { id: string };

  const invalidValue = await app.request(
    "/api/directory/records",
    jsonRequest("POST", {
      typeId: createdType.id,
      name: "Unidade inválida",
      values: { [field.id]: "dez" },
    }),
  );
  assert.equal(invalidValue.status, 400);
  assert.equal(
    ((await invalidValue.json()) as ApiErrorResponse).error.code,
    "validation_error",
  );

  const unknownAssociation = await app.request(
    "/api/directory/records",
    jsonRequest("POST", {
      typeId: createdType.id,
      name: "Unidade órfã",
      groupIds: ["grupo-inexistente"],
    }),
  );
  assert.equal(unknownAssociation.status, 404);
  assert.equal(
    ((await unknownAssociation.json()) as ApiErrorResponse).error.code,
    "not_found",
  );

  const unknownRecord = await app.request(
    "/api/directory/records/registro-inexistente",
    jsonRequest("PUT", {
      typeId: organization.id,
      name: "Não existe",
    }),
  );
  assert.equal(unknownRecord.status, 404);
  assert.equal(
    ((await unknownRecord.json()) as ApiErrorResponse).error.code,
    "not_found",
  );

  const invalidJson = await app.request("/api/directory/segments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  });
  assert.equal(invalidJson.status, 400);
  assert.equal(
    ((await invalidJson.json()) as ApiErrorResponse).error.code,
    "invalid_json",
  );
});

test("API aplica papéis: leitura para viewer, operação para operator e esquema para admin", async () => {
  const database = createDatabase(":memory:");
  databases.push(database);
  const auth = new LocalAuthService(database);
  const owner = await auth.bootstrapSetup({
    organizationName: "Instalação local",
    workspaceName: "Suporte",
    timezone: "America/Sao_Paulo",
    username: "owner",
    displayName: "Pessoa proprietária",
    password: "senha-local-segura-123",
  });
  await auth.createUser(owner.token, {
    username: "operator",
    displayName: "Pessoa operadora",
    role: "operator",
    password: "senha-local-segura-456",
  });
  await auth.createUser(owner.token, {
    username: "viewer",
    displayName: "Pessoa leitora",
    role: "viewer",
    password: "senha-local-segura-789",
  });
  const operator = await auth.login({
    username: "operator",
    password: "senha-local-segura-456",
  });
  const viewer = await auth.login({
    username: "viewer",
    password: "senha-local-segura-789",
  });
  const ownerCookie = `threadmark_session=${owner.token}`;
  const operatorCookie = `threadmark_session=${operator.token}`;
  const viewerCookie = `threadmark_session=${viewer.token}`;
  const app = createApiApp(new SupportStore(database), undefined, undefined, { auth });

  const unauthenticated = await app.request("/api/directory");
  assert.equal(unauthenticated.status, 401);

  const viewerRead = await app.request("/api/directory", {
    headers: { cookie: viewerCookie },
  });
  assert.equal(viewerRead.status, 200);
  const snapshot = (await viewerRead.json()) as DirectorySnapshotDto;
  const organization = snapshot.recordTypes.find(
    (recordType) => recordType.slug === "organizacao",
  );
  assert.ok(organization);

  const viewerMutation = await app.request(
    "/api/directory/records",
    jsonRequest(
      "POST",
      { typeId: organization.id, name: "Viewer não pode criar" },
      viewerCookie,
    ),
  );
  assert.equal(viewerMutation.status, 403);

  const operatorSchemaMutation = await app.request(
    "/api/directory/types",
    jsonRequest(
      "POST",
      { name: "Projeto", pluralName: "Projetos" },
      operatorCookie,
    ),
  );
  assert.equal(operatorSchemaMutation.status, 403);

  const ownerSchemaMutation = await app.request(
    "/api/directory/types",
    jsonRequest(
      "POST",
      { name: "Projeto", pluralName: "Projetos" },
      ownerCookie,
    ),
  );
  assert.equal(ownerSchemaMutation.status, 201);
  const projectType = (await ownerSchemaMutation.json()) as DirectoryRecordTypeDto;

  const operatorRecordMutation = await app.request(
    "/api/directory/records",
    jsonRequest(
      "POST",
      { typeId: projectType.id, name: "Projeto Exemplo Ômega" },
      operatorCookie,
    ),
  );
  assert.equal(operatorRecordMutation.status, 201);
  const project = (await operatorRecordMutation.json()) as DirectoryRecordDto;
  assert.equal(project.name, "Projeto Exemplo Ômega");

  const operatorArchive = await app.request(
    `/api/directory/records/${project.id}`,
    { method: "DELETE", headers: { cookie: operatorCookie } },
  );
  assert.equal(operatorArchive.status, 403);

  const ownerArchive = await app.request(
    `/api/directory/records/${project.id}`,
    { method: "DELETE", headers: { cookie: ownerCookie } },
  );
  assert.equal(ownerArchive.status, 200);
});
