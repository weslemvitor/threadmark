import assert from "node:assert/strict";
import test from "node:test";

import {
  assertResolvedDestinationAllowed,
  assertUrlAllowed,
  createCustomHttpExecutor,
  createSlackWebhookExecutor,
  customHttpConfigSchema,
  executeExternalHttp,
  IntegrationRequestError,
  publicHeaderSchema,
  renderJsonTemplate,
  safeHttpUrlSchema,
  sanitizeExternalOutput,
} from "../server/integrations/index.js";

const publicLookup = async () => [{ address: "93.184.216.34" }];
const executionContext = {
  executionId: "execution-123",
  automationId: "automation-123",
  nodeId: "node-123",
  idempotencyKey: "automation-123:node-123:attempt-1",
};

test("validação rejeita credenciais na URL e headers públicos sensíveis", () => {
  assert.throws(
    () => safeHttpUrlSchema.parse("https://user:password@example.com/hook"),
    /Credenciais/,
  );
  assert.throws(
    () => safeHttpUrlSchema.parse("https://example.com/hook?api_key=segredo"),
    /Segredos/,
  );
  assert.throws(
    () => publicHeaderSchema.parse({ name: "Authorization", value: "Bearer segredo" }),
    /cofre local/,
  );
  assert.throws(
    () => publicHeaderSchema.parse({ name: "X-Test", value: "ok\r\ninjected: yes" }),
    /quebras de linha/,
  );
});

test("política SSRF bloqueia host local, IP privado e DNS que resolve para rede privada", async () => {
  assert.throws(
    () => assertUrlAllowed(new URL("http://localhost:3000/hook")),
    /bloqueadas por padrão/,
  );
  assert.throws(
    () => assertUrlAllowed(new URL("https://169.254.169.254/latest/meta-data")),
    /bloqueadas por padrão/,
  );
  assert.throws(
    () => assertUrlAllowed(new URL("http://[::ffff:127.0.0.1]/hook")),
    /bloqueadas por padrão/,
  );
  await assert.rejects(
    assertResolvedDestinationAllowed(
      new URL("https://public-looking.example/hook"),
      false,
      async () => [{ address: "10.0.0.12" }],
    ),
    (error: unknown) =>
      error instanceof IntegrationRequestError && error.kind === "blocked",
  );
});

test("rede privada exige opt-in local explícito", async () => {
  let called = false;
  const result = await executeExternalHttp(
    {
      endpoint: "http://127.0.0.1:4567/hook",
      method: "POST",
      body: { ok: true },
      idempotencyKey: executionContext.idempotencyKey,
      allowPrivateNetwork: true,
    },
    {
      fetchImpl: async () => {
        called = true;
        return Response.json({ accepted: true });
      },
    },
  );
  assert.equal(called, true);
  assert.equal(result.ok, true);
});

test("template JSON substitui variáveis com tipo e bloqueia acesso a segredos/protótipos", () => {
  assert.deepEqual(
    renderJsonTemplate(
      {
        title: "Ticket {{ticket.id}} - {{ticket.title}}",
        priority: "{{ticket.priority}}",
        requester: "{{requester}}",
      },
      {
        ticket: { id: 42, title: "Falha no dashboard", priority: 3 },
        requester: { name: "Cliente" },
      },
    ),
    {
      title: "Ticket 42 - Falha no dashboard",
      priority: 3,
      requester: { name: "Cliente" },
    },
  );
  assert.throws(
    () => renderJsonTemplate({ leaked: "{{secrets.apiKey}}" }, { secrets: { apiKey: "x" } }),
    /não permitida/,
  );
  assert.throws(
    () => renderJsonTemplate({ value: "{{ticket.__proto__}}" }, { ticket: {} }),
    /não permitida/,
  );
  assert.throws(
    () => renderJsonTemplate({ value: "{{missing.value}}" }, {}),
    /não está disponível/,
  );
});

test("executor HTTP personalizado resolve segredos só no cofre, renderiza e encaminha idempotência", async () => {
  const secret = "Bearer segredo-super-privado";
  const vaultReads: string[] = [];
  const capturedRequests: RequestInit[] = [];
  let capturedBody = "";
  const executor = createCustomHttpExecutor(
    {
      async get(reference) {
        vaultReads.push(reference);
        return secret;
      },
    },
    {
      lookup: publicLookup,
      fetchImpl: async (_input, init) => {
        capturedRequests.push(init ?? {});
        capturedBody = String(init?.body);
        return Response.json(
          {
            created: true,
            token: "não deve aparecer",
            harmlessEcho: secret,
          },
          { headers: { "x-request-id": secret } },
        );
      },
    },
  );

  const config = {
    endpoint: "https://api.example.com/customer-requests",
    method: "POST" as const,
    publicHeaders: [{ name: "X-Workspace", value: "support" }],
    secretHeaders: [{ name: "Authorization", secretRef: "integration:http:auth" }],
    bodyTemplate: { title: "{{ticket.title}}", ticketId: "{{ticket.id}}" },
    timeoutMs: 1_000,
  };
  assert.equal(JSON.stringify(customHttpConfigSchema.parse(config)).includes(secret), false);

  const result = await executor.execute(
    config,
    { variables: { ticket: { id: 91, title: "Dados incorretos" } } },
    executionContext,
  );

  const capturedHeaders = new Headers(capturedRequests[0]?.headers);
  assert.deepEqual(vaultReads, ["integration:http:auth"]);
  assert.equal(capturedHeaders.get("authorization"), secret);
  assert.equal(
    capturedHeaders.get("idempotency-key"),
    executionContext.idempotencyKey,
  );
  assert.deepEqual(JSON.parse(capturedBody), {
    title: "Dados incorretos",
    ticketId: 91,
  });
  assert.deepEqual(result, {
    ok: true,
    status: 200,
    requestId: "[redacted]",
    output: {
      created: true,
      token: "[redacted]",
      harmlessEcho: "[redacted]",
    },
    truncated: false,
  });
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("Slack usa URL secreta sem devolvê-la e deixa deduplicação com o engine", async () => {
  const webhookUrl = "https://hooks.slack.example/services/secret-value";
  const capturedRequests: RequestInit[] = [];
  const executor = createSlackWebhookExecutor(
    { async get() { return webhookUrl; } },
    {
      lookup: publicLookup,
      fetchImpl: async (_input, init) => {
        capturedRequests.push(init ?? {});
        return new Response("ok", { status: 200 });
      },
    },
  );
  const result = await executor.execute(
    { webhookSecretRef: "integration:slack:webhook", timeoutMs: 1_000 },
    { text: "Ticket urgente criado" },
    executionContext,
  );
  const capturedHeaders = new Headers(capturedRequests[0]?.headers);
  assert.equal(capturedHeaders.has("idempotency-key"), false);
  assert.equal(JSON.stringify(result).includes(webhookUrl), false);
});

test("respostas externas são limitadas e sanitizadas", async () => {
  const result = await executeExternalHttp(
    {
      endpoint: "https://api.example.com/large",
      method: "POST",
      body: {},
      idempotencyKey: executionContext.idempotencyKey,
    },
    {
      lookup: publicLookup,
      maxResponseBytes: 256,
      fetchImpl: async () => new Response("x".repeat(2_000)),
    },
  );
  assert.equal(result.truncated, true);
  assert.equal((result.output as string).length, 256);
  assert.deepEqual(
    sanitizeExternalOutput({ password: "secret", nested: { apiKey: "key" } }),
    { password: "[redacted]", nested: { apiKey: "[redacted]" } },
  );
});

test("timeout interrompe a chamada externa com erro seguro", async () => {
  await assert.rejects(
    executeExternalHttp(
      {
        endpoint: "https://api.example.com/slow",
        method: "POST",
        body: {},
        idempotencyKey: executionContext.idempotencyKey,
        timeoutMs: 250,
      },
      {
        lookup: publicLookup,
        fetchImpl: async (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          }),
      },
    ),
    (error: unknown) =>
      error instanceof IntegrationRequestError &&
      error.kind === "timeout" &&
      /250ms/.test(error.message),
  );
});
