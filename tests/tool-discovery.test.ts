import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { searchInvestigationTools } from "../server/agent/tool-discovery.js";
import type { InvestigationToolDescriptor } from "../server/agent/types.js";
import { createDatabase } from "../server/db/index.js";
import { LocalSecretVault } from "../server/runtime/secret-vault.js";
import { DeepToolExecutor } from "../server/tools/deep-tool-executor.js";
import { LocalToolService } from "../server/tools/local-tool-service.js";

const catalog: InvestigationToolDescriptor[] = [
  {
    id: "code",
    name: "Código Adstart",
    type: "codebase",
    description: "Regras de negócio do produto",
    scope: "/produto",
    operations: [
      { name: "search_files", description: "Busca texto nos arquivos", argumentsExample: "{}", effect: "read" },
      { name: "read_files", description: "Lê arquivos encontrados", argumentsExample: "{}", effect: "read" },
    ],
  },
  {
    id: "aws",
    name: "CloudWatch de produção",
    type: "aws_cloudwatch",
    description: "Logs e métricas das Lambdas",
    scope: "log groups autorizados",
    operations: [
      { name: "query_logs", description: "Consulta logs em uma janela limitada", argumentsExample: "{}", effect: "read" },
      { name: "read_metrics", description: "Consulta métricas da AWS", argumentsExample: "{}", effect: "read" },
    ],
  },
  {
    id: "external",
    name: "Integração externa",
    type: "connected_app",
    description: "Publica mensagens",
    scope: "app conectado",
    operations: [
      { name: "send_message", description: "Envia mensagem ao cliente", argumentsExample: "{}", effect: "write", authorization: "task" },
    ],
  },
];

test("descoberta seleciona operações relevantes e reduz o catálogo", () => {
  const result = searchInvestigationTools(catalog, {
    query: "investigar erro de campanha nos logs da AWS",
    limit: 2,
  });

  assert.equal(result.matches[0]?.toolId, "aws");
  assert.equal(result.matches[0]?.operation, "query_logs");
  assert.ok(result.descriptors.every((descriptor) => descriptor.id !== "external"));
  assert.ok(result.selectedCatalogCharacters < result.sourceCatalogCharacters * 0.6);
});

test("descoberta não amplia autorização nem oferece escrita por padrão", () => {
  const authorizedSubset = catalog.filter((descriptor) => descriptor.id !== "aws");
  const result = searchInvestigationTools(authorizedSubset, {
    query: "enviar mensagem e consultar logs da AWS",
  });

  assert.ok(result.descriptors.every((descriptor) => descriptor.id !== "aws"));
  assert.ok(result.descriptors.every((descriptor) =>
    descriptor.operations.every((operation) => operation.effect !== "write")
  ));
});

test("descoberta não envia caminhos locais nem host de banco ao modelo", () => {
  const sensitiveCatalog: InvestigationToolDescriptor[] = [
    {
      ...catalog[0]!,
      scope: "/workspace/private-project",
    },
    {
      id: "database",
      name: "PostgreSQL",
      type: "postgres_readonly",
      description: "Banco operacional",
      scope: "internal-db.example.local:5432/adstart",
      operations: [{
        name: "query_readonly",
        description: "Consulta SQL readonly",
        argumentsExample: "{}",
        effect: "read",
      }],
    },
  ];
  const result = searchInvestigationTools(sensitiveCatalog, {
    query: "buscar código e consultar banco",
  });
  const serialized = JSON.stringify(result.descriptors);

  assert.doesNotMatch(serialized, /\/workspace\/private-project/);
  assert.doesNotMatch(serialized, /internal-db\.example\.local/);
});

test("descoberta executa a operação encontrada pelo broker readonly real", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "threadmark-tool-discovery-"));
  const codeRoot = path.join(temporary, "code");
  await mkdir(path.join(codeRoot, "server"), { recursive: true });
  await writeFile(
    path.join(codeRoot, "server", "campaign-service.ts"),
    'export const CAMPAIGN_RETRY_LIMIT = 3;\nexport function retryCampaign() { return CAMPAIGN_RETRY_LIMIT; }\n',
  );
  const database = createDatabase(":memory:");
  const service = new LocalToolService(
    database,
    new LocalSecretVault(path.join(temporary, "secrets")),
  );
  await service.create({
    type: "codebase",
    name: "Código do produto",
    description: "Regras de campanha",
    config: { rootPath: codeRoot },
    allowedOperations: ["list_files", "search_files", "read_files"],
  }, "test");
  const executor = new DeepToolExecutor(service);

  try {
    const discovery = searchInvestigationTools(executor.descriptors(), {
      query: "buscar regra de campaign no código",
      limit: 1,
    });
    const match = discovery.matches[0];
    assert.ok(match);
    assert.equal(match.operation, "search_files");

    const execution = await executor.execute({
      requestId: "discovery-e2e-1",
      toolId: match.toolId,
      operation: match.operation,
      argumentsJson: JSON.stringify({
        query: "CAMPAIGN_RETRY_LIMIT",
        path: "server",
        glob: "*.ts",
        maxResults: 10,
      }),
      purpose: "Comprovar descoberta e execução readonly de ponta a ponta.",
    });

    assert.equal(execution.status, "success", execution.summary);
    assert.match(execution.content, /campaign-service\.ts/);
    assert.match(execution.content, /CAMPAIGN_RETRY_LIMIT/);
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
