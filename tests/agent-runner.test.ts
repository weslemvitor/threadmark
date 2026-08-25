import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildCodexEnvironment,
  CodexSupportAgent,
  isolatedCodexConfigArgs,
  prepareIsolatedCodexHome,
} from "../server/agent/codex-runner.js";
import type {
  InvestigationThreadInput,
  SupportAnalysisInput,
  TriageAnalysisInput,
} from "../server/agent/types.js";

const validAnalysis = {
  createTicket: true,
  outcome: "technical_investigation_required",
  relation: "uncertain",
  relatedTicketId: null,
  title: "Anexo em revisao",
  summary: "O print precisa ser analisado.",
  affectedEcommerce: null,
  priority: "normal",
  categories: {
    contactReason: [],
    productArea: [],
    platform: [],
    symptom: [],
  },
  evidence: [],
  suggestedResponse: null,
  missingInformation: [],
  nextAction: "Revisar o print.",
  confidence: 0.5,
} as const;

const validTurn = {
  assistantMessage: "A investigação readonly foi concluída.",
  phase: "conclusion",
  threadSummary: "Investigação concluída.",
  findings: [{
    statement: "A conversa atual sustenta a orientação proposta.",
    kind: "fact",
    evidenceReferences: ["message-thread"],
  }],
  evidence: [{
    source: "conversation",
    summary: "A conversa atual sustenta a orientação proposta.",
    reference: "message-thread",
  }],
  suggestedResponse: "Resposta segura.",
  nextAction: "Revisar a resposta.",
  confidence: 0.9,
  toolRequests: [],
} as const;

function emptyReplyContext() {
  return {
    conversationState: {
      lastExternalMessageAt: null,
      lastSentResponseAt: null,
      unansweredExternalMessageIds: [] as string[],
      hasUnansweredExternalMessages: false,
    },
    sentResponses: [],
    resolvedPrecedents: [],
  };
}

test("runner anexa somente imagens dentro da raiz local confiavel", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "support-agent-"));
  const attachmentsRoot = path.join(temporary, "attachments");
  const trustedImage = path.join(attachmentsRoot, "trusted.png");
  const outsideImage = path.join(temporary, "outside.png");
  await mkdir(attachmentsRoot, { recursive: true });
  await writeFile(trustedImage, "not-a-real-image");
  await writeFile(outsideImage, "private");
  let receivedArgv: string[] = [];
  let receivedPrompt = "";
  let preparedImageBody = "";

  const runner = new CodexSupportAgent(
    {
      cwd: temporary,
      dataDir: path.join(temporary, "runs"),
      attachmentsRoot,
    },
    async ({ argv, stdin }) => {
      receivedArgv = argv;
      receivedPrompt = stdin;
      const imageFlag = argv.indexOf("--image");
      if (imageFlag !== -1) {
        preparedImageBody = await readFile(argv[imageFlag + 1] as string, "utf8");
      }
      const outputFlag = argv.indexOf("--output-last-message");
      await writeFile(argv[outputFlag + 1] as string, JSON.stringify(validAnalysis));
      return { exitCode: 0, stderr: "" };
    },
  );
  const input: SupportAnalysisInput = {
    accountName: "Cliente",
    accountType: "ecommerce",
    groupName: "Suporte Cliente",
    knownEcommerces: [],
    ...emptyReplyContext(),
    openTickets: [],
    messages: [
      {
        id: "message-1",
        author: "Cliente",
        role: "external",
        timestampUtc: new Date().toISOString(),
        text: "Veja os prints",
        quotedMessageId: null,
        attachments: [
          {
            kind: "image",
            fileName: "trusted.png",
            localPath: trustedImage,
            extractedText: null,
          },
          {
            kind: "image",
            fileName: "outside.png",
            localPath: outsideImage,
            extractedText: null,
          },
        ],
      },
    ],
  };

  try {
    await runner.analyse(input);
    const imageArguments = receivedArgv
      .map((value, index) => (receivedArgv[index - 1] === "--image" ? value : null))
      .filter((value): value is string => Boolean(value));
    assert.equal(imageArguments.length, 1);
    assert.notEqual(imageArguments[0], await realpath(trustedImage));
    assert.match(imageArguments[0] ?? "", /threadmark-codex-.*image-1\.png/);
    assert.equal(preparedImageBody, "not-a-real-image");
    assert.doesNotMatch(receivedPrompt, new RegExp(temporary.replaceAll("/", "\\/")));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("runner Codex anexa imagem aprovada pelo operador na investigação profunda", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "threadmark-codex-image-"));
  const attachmentsRoot = path.join(temporary, "attachments");
  const trustedImage = path.join(attachmentsRoot, "operator.png");
  await mkdir(attachmentsRoot, { recursive: true });
  await writeFile(trustedImage, "operator-image");
  let receivedArgv: string[] = [];
  const runner = new CodexSupportAgent(
    {
      cwd: temporary,
      dataDir: path.join(temporary, "runs"),
      attachmentsRoot,
    },
    async ({ argv }) => {
      receivedArgv = argv;
      const outputFlag = argv.indexOf("--output-last-message");
      await writeFile(argv[outputFlag + 1] as string, JSON.stringify(validTurn));
      return { exitCode: 0, stderr: "" };
    },
  );
  const input: InvestigationThreadInput = {
    threadId: "thread-image",
    currentOperatorMessageId: "operator-image-message",
    durableSummary: "",
    recentMessages: [{
      id: "operator-image-message",
      role: "operator",
      body: "Analise o print.",
      phase: null,
      createdAt: "2026-08-20T16:00:00.000Z",
    }],
    images: [{
      id: "thread-image-1",
      messageId: "operator-image-message",
      fileName: "operator.png",
      mimeType: "image/png",
      localPath: trustedImage,
      sizeBytes: 14,
    }],
    imageAnalysisApproved: true,
    ticket: {
      accountName: "Cliente",
      accountType: "ecommerce",
      groupName: "Suporte Cliente",
      knownEcommerces: [],
      ...emptyReplyContext(),
      openTickets: [],
      messages: [{
        id: "message-thread",
        author: "Cliente",
        role: "external",
        timestampUtc: "2026-08-20T15:59:00.000Z",
        text: "Veja o print.",
        attachments: [],
        quotedMessageId: null,
      }],
    },
    automaticInvestigation: null,
  };

  try {
    await runner.investigateThread(input);
    assert.equal(receivedArgv.filter((value) => value === "--image").length, 1);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("runner isola análise automática e investigação profunda do ambiente pessoal", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "support-agent-env-"));
  const invocations: Array<{
    argv: string[];
    cwd: string;
    env: Record<string, string | undefined>;
    schema: string;
    timeoutMs: number | null;
  }> = [];
  const sourceEnvironment: Record<string, string | undefined> = {
    HOME: "/Users/tester",
    PATH: "/usr/bin:/bin",
    USER: "tester",
    LANG: "pt_BR.UTF-8",
    AWS_PROFILE: "readonly-support",
    OPENAI_API_KEY: "nao-deve-vazar",
    DATABASE_PASSWORD: "nao-deve-vazar",
    NODE_OPTIONS: "--require /tmp/injection.js",
  };
  const runner = new CodexSupportAgent(
    {
      cwd: temporary,
      dataDir: path.join(temporary, "runs"),
      attachmentsRoot: path.join(temporary, "attachments"),
      environment: sourceEnvironment,
    },
    async ({ argv, cwd, env, timeoutMs }) => {
      const schemaFlag = argv.indexOf("--output-schema");
      const schema = argv[schemaFlag + 1] as string;
      invocations.push({ argv, cwd, env, schema, timeoutMs });
      const outputFlag = argv.indexOf("--output-last-message");
      await writeFile(
        argv[outputFlag + 1] as string,
        JSON.stringify(
          schema.endsWith("investigation-turn.schema.json")
            ? validTurn
            : validAnalysis,
        ),
      );
      return { exitCode: 0, stderr: "" };
    },
  );
  const automaticInput: SupportAnalysisInput = {
    accountName: "Cliente",
    accountType: "ecommerce",
    groupName: "Grupo",
    knownEcommerces: [],
    ...emptyReplyContext(),
    messages: [{
      id: "message-thread",
      author: "Cliente",
      role: "external",
      timestampUtc: "2026-07-17T09:59:00.000Z",
      text: "Preciso de ajuda com este caso.",
      quotedMessageId: null,
      attachments: [],
    }],
    openTickets: [],
  };
  const threadInput: InvestigationThreadInput = {
    threadId: "thread",
    currentOperatorMessageId: "operator",
    durableSummary: "Resumo",
    recentMessages: [
      {
        id: "operator",
        role: "operator",
        body: "Investigue em modo readonly.",
        phase: null,
        createdAt: "2026-07-17T10:00:00.000Z",
      },
    ],
    ticket: automaticInput,
    automaticInvestigation: null,
  };

  try {
    await runner.analyse(automaticInput, "automatic-model");
    await runner.investigateThread(threadInput, "deep-model");

    const automatic = invocations[0];
    const deep = invocations[1];
    assert.ok(automatic);
    assert.ok(deep);
    assert.notEqual(automatic.cwd, temporary);
    assert.match(automatic.cwd, /threadmark-codex-/);
    assert.equal(automatic.cwd.startsWith(path.join(temporary, "runs")), false);
    assert.ok(automatic.argv.includes("--ignore-user-config"));
    assert.ok(automatic.argv.includes("--ignore-rules"));
    assert.ok(automatic.argv.includes("--skip-git-repo-check"));
    assert.equal(automatic.argv[automatic.argv.indexOf("--model") + 1], "automatic-model");
    assert.ok(automatic.argv.includes("approval_policy=\"never\""));
    assert.ok(automatic.argv.includes("web_search=\"disabled\""));
    assert.ok(automatic.argv.includes("mcp_servers={}"));
    assert.ok(automatic.argv.includes("project_root_markers=[]"));
    assert.ok(automatic.argv.includes("project_doc_max_bytes=0"));
    assert.ok(
      automatic.argv.some((value) =>
        value.startsWith("skills.config=[") &&
        value.includes("enabled=false"),
      ),
    );
    for (const feature of [
      "shell_tool",
      "unified_exec",
      "apps",
      "browser_use",
      "computer_use",
      "plugins",
      "multi_agent",
    ]) {
      const featureIndex = automatic.argv.indexOf(feature);
      assert.notEqual(featureIndex, -1, feature);
      assert.equal(automatic.argv[featureIndex - 1], "--disable", feature);
    }
    assert.match(automatic.env.HOME ?? "", /threadmark-codex-.*home/);
    assert.match(
      automatic.env.XDG_CONFIG_HOME ?? "",
      /threadmark-codex-.*home.*\.config/,
    );
    assert.match(
      automatic.env.CODEX_HOME ?? "",
      /threadmark-codex-.*codex-home/,
    );
    assert.doesNotMatch(JSON.stringify(automatic.argv), /Users\/tester/);
    assert.equal(automatic.env.AWS_PROFILE, undefined);
    assert.notEqual(deep.cwd, temporary);
    assert.match(deep.cwd, /threadmark-codex-/);
    assert.equal(automatic.timeoutMs, 300_000);
    assert.equal(deep.timeoutMs, null);
    assert.ok(deep.argv.includes("--ignore-user-config"));
    assert.ok(deep.argv.includes("--ignore-rules"));
    assert.ok(deep.argv.includes("--skip-git-repo-check"));
    assert.equal(deep.argv[deep.argv.indexOf("--model") + 1], "deep-model");
    assert.match(deep.env.HOME ?? "", /threadmark-codex-.*home/);
    assert.match(deep.env.CODEX_HOME ?? "", /threadmark-codex-.*codex-home/);
    assert.equal(deep.env.AWS_PROFILE, undefined);
    assert.ok(deep.argv.includes("mcp_servers={}"));
    for (const feature of [
      "shell_tool",
      "unified_exec",
      "apps",
      "browser_use",
      "computer_use",
      "plugins",
      "multi_agent",
    ]) {
      const featureIndex = deep.argv.indexOf(feature);
      assert.notEqual(featureIndex, -1, feature);
      assert.equal(deep.argv[featureIndex - 1], "--disable", feature);
    }
    for (const invocation of invocations) {
      assert.equal(invocation.env.OPENAI_API_KEY, undefined);
      assert.equal(invocation.env.DATABASE_PASSWORD, undefined);
      assert.equal(invocation.env.NODE_OPTIONS, undefined);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("modelo default usa a escolha da conta Codex sem enviar slug literal", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "support-agent-default-model-"));
  let receivedArgv: string[] = [];
  const runner = new CodexSupportAgent(
    {
      cwd: temporary,
      dataDir: path.join(temporary, "runs"),
      environment: { HOME: temporary, PATH: "/usr/bin:/bin" },
    },
    async ({ argv }) => {
      receivedArgv = argv;
      const outputFlag = argv.indexOf("--output-last-message");
      await writeFile(argv[outputFlag + 1] as string, JSON.stringify(validAnalysis));
      return { exitCode: 0, stderr: "" };
    },
  );

  try {
    await runner.analyse({
      accountName: "Cliente",
      accountType: "ecommerce",
      groupName: "Grupo",
      knownEcommerces: [],
      ...emptyReplyContext(),
      messages: [],
      openTickets: [],
    }, "default");
    assert.equal(receivedArgv.includes("--model"), false);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("runner Codex rejeita precedente resolvido que não veio no contexto", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "support-agent-precedent-"));
  const runner = new CodexSupportAgent(
    {
      cwd: temporary,
      dataDir: path.join(temporary, "runs"),
      environment: { HOME: temporary, PATH: "/usr/bin:/bin" },
    },
    async ({ argv }) => {
      const schemaFlag = argv.indexOf("--output-schema");
      const outputFlag = argv.indexOf("--output-last-message");
      const isTurn = argv[schemaFlag + 1]?.endsWith(
        "investigation-turn.schema.json",
      );
      await writeFile(
        argv[outputFlag + 1] as string,
        JSON.stringify(isTurn
          ? {
              ...validTurn,
              findings: [{
                statement: "O precedente inventado confirmaria a orientação.",
                kind: "fact",
                evidenceReferences: ["ticket-inventado"],
              }],
              evidence: [{
                source: "resolved_ticket",
                summary: "Precedente inventado.",
                reference: "ticket-inventado",
              }],
            }
          : {
              ...validAnalysis,
              evidence: [{
                source: "resolved_ticket",
                summary: "Precedente inventado.",
                reference: "ticket-inventado",
              }],
            }),
      );
      return { exitCode: 0, stderr: "" };
    },
  );
  const ticket: SupportAnalysisInput = {
    accountName: "Cliente",
    accountType: "ecommerce",
    groupName: "Grupo",
    knownEcommerces: [],
    ...emptyReplyContext(),
    messages: [],
    openTickets: [],
  };
  ticket.resolvedPrecedents = [{
    ticketId: "ticket-resolvido-1",
    title: "Caso resolvido",
    summary: "Precedente compatível.",
    resolvedAt: "2026-07-17T10:00:00.000Z",
    affectedStore: null,
    categories: ["Pedidos"],
    resolution: {
      summary: "Integração reativada.",
      rootCause: "Credencial inválida.",
      outcome: "Resolvido",
      validatedAt: "2026-07-17T10:00:00.000Z",
    },
    finalResponse: "Integração reativada.",
  }];

  try {
    await assert.rejects(runner.analyse(ticket), /ticketId exato/i);
    await assert.rejects(
      runner.investigateThread({
        threadId: "thread-precedent",
        currentOperatorMessageId: "operator-1",
        durableSummary: "",
        recentMessages: [{
          id: "operator-1",
          role: "operator",
          body: "Investigue.",
          phase: null,
          createdAt: "2026-07-18T10:00:00.000Z",
        }],
        ticket,
        automaticInvestigation: null,
      }),
      /ticketId exato/i,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("runner limita textos e PDFs no prompt sem alterar a entrada original", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "support-agent-limit-"));
  let promptReceived = "";
  const runner = new CodexSupportAgent(
    {
      cwd: temporary,
      dataDir: path.join(temporary, "runs"),
      attachmentsRoot: path.join(temporary, "attachments"),
      environment: { HOME: temporary, PATH: "/usr/bin:/bin" },
    },
    async ({ argv, stdin }) => {
      promptReceived = stdin;
      const outputFlag = argv.indexOf("--output-last-message");
      await writeFile(argv[outputFlag + 1] as string, JSON.stringify(validAnalysis));
      return { exitCode: 0, stderr: "" };
    },
  );
  const hugeText = "inicio-" + "x".repeat(20_000) + "-fim";
  const input: SupportAnalysisInput = {
    accountName: "Cliente",
    accountType: "ecommerce",
    groupName: "Grupo",
    knownEcommerces: [],
    conversationState: {
      lastExternalMessageAt: "2026-07-17T10:59:00.000Z",
      lastSentResponseAt: "2026-07-17T10:30:00.000Z",
      unansweredExternalMessageIds: Array.from(
        { length: 60 },
        (_, index) => `unanswered-${index}-${"i".repeat(600)}`,
      ),
      hasUnansweredExternalMessages: true,
    },
    messages: Array.from({ length: 60 }, (_, index) => ({
      id: `message-${index}`,
      author: "Cliente",
      role: "external" as const,
      timestampUtc: `2026-07-17T10:${String(index).padStart(2, "0")}:00.000Z`,
      text: hugeText,
      quotedMessageId: null,
      attachments: [
        {
          kind: "document" as const,
          fileName: `arquivo-${index}.pdf`,
          mimeType: "application/pdf",
          localPath: `/tmp/arquivo-${index}.pdf`,
          extractedText: hugeText,
        },
      ],
    })),
    sentResponses: Array.from({ length: 40 }, (_, index) => ({
      id: `response-${index}-${"r".repeat(600)}`,
      messageId: `message-${index}-${"m".repeat(600)}`,
      body: hugeText,
      sentAt: "2026-07-17T10:30:00.000Z",
    })),
    openTickets: [],
    resolvedPrecedents: Array.from({ length: 25 }, (_, index) => ({
      ticketId: `precedent-${index}-${"p".repeat(600)}`,
      title: hugeText,
      summary: hugeText,
      resolvedAt: "2026-07-16T10:00:00.000Z",
      affectedStore: {
        id: `store-${index}-${"i".repeat(600)}`,
        name: "n".repeat(600),
      },
      categories: Array.from({ length: 35 }, () => "c".repeat(300)),
      resolution: {
        summary: hugeText,
        rootCause: hugeText,
        outcome: hugeText,
        validatedAt: "2026-07-16T10:00:00.000Z",
      },
      finalResponse: hugeText,
    })),
  };

  try {
    await runner.analyse(input);
    const match = promptReceived.match(
      /<DADOS_NAO_CONFIAVEIS>\n([\s\S]+)\n<\/DADOS_NAO_CONFIAVEIS>/,
    );
    assert.ok(match?.[1]);
    const bounded = JSON.parse(match[1]) as SupportAnalysisInput;
    assert.equal(bounded.messages.length, 50);
    assert.equal(bounded.sentResponses.length, 30);
    assert.equal(bounded.sentResponses[0]?.id.length, 500);
    assert.equal(bounded.sentResponses[0]?.messageId?.length, 500);
    assert.ok((bounded.sentResponses[0]?.body.length ?? 0) <= 8_000);
    assert.equal(bounded.resolvedPrecedents.length, 20);
    assert.equal(bounded.resolvedPrecedents[0]?.ticketId.length, 500);
    assert.equal(bounded.resolvedPrecedents[0]?.affectedStore?.id.length, 500);
    assert.equal(bounded.resolvedPrecedents[0]?.affectedStore?.name.length, 500);
    assert.equal(bounded.resolvedPrecedents[0]?.categories.length, 30);
    assert.ok((bounded.resolvedPrecedents[0]?.resolution.summary.length ?? 0) <= 8_000);
    assert.equal(bounded.conversationState.unansweredExternalMessageIds.length, 50);
    assert.equal(bounded.conversationState.unansweredExternalMessageIds[0]?.length, 500);
    const contentCharacters = bounded.messages.reduce(
      (total, message) =>
        total +
        (message.text?.length ?? 0) +
        message.attachments.reduce(
          (attachmentTotal, attachment) =>
            attachmentTotal + (attachment.extractedText?.length ?? 0),
          0,
        ),
      0,
    );
    assert.ok(contentCharacters <= 160_000);
    assert.match(promptReceived, /conteúdo truncado pelo limite do runner/);
    assert.equal(input.messages.length, 60);
    assert.equal(input.messages[0]?.text, hugeText);
    assert.equal(input.sentResponses.length, 40);
    assert.equal(input.resolvedPrecedents.length, 25);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("allowlist nunca aceita variáveis de injeção de processo", () => {
  const environment = buildCodexEnvironment(
    {
      PATH: "/usr/bin",
      SAFE_CUSTOM: "ok",
      NODE_OPTIONS: "--require malware.js",
      LD_PRELOAD: "/tmp/malware.so",
    },
    ["SAFE_CUSTOM", "NODE_OPTIONS", "LD_PRELOAD"],
  );
  assert.deepEqual(environment, { PATH: "/usr/bin", SAFE_CUSTOM: "ok" });
});

test("home isolado do Codex copia somente autenticação e desativa contexto auxiliar", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "support-codex-home-"));
  const sourceHome = path.join(temporary, "source-home");
  const runDir = path.join(temporary, "run");
  await mkdir(path.join(sourceHome, "skills", "personal"), { recursive: true });
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(sourceHome, "auth.json"), "auth-sentinel", { mode: 0o600 });
  await writeFile(path.join(sourceHome, "AGENTS.md"), "private-agent-sentinel");
  await writeFile(path.join(sourceHome, "config.toml"), "developer_instructions='private'");
  await writeFile(
    path.join(sourceHome, "skills", "personal", "SKILL.md"),
    "private-skill-sentinel",
  );

  try {
    const isolatedHome = await prepareIsolatedCodexHome(runDir, sourceHome);
    assert.equal(
      await readFile(path.join(isolatedHome, "auth.json"), "utf8"),
      "auth-sentinel",
    );
    await assert.rejects(readFile(path.join(isolatedHome, "AGENTS.md"), "utf8"));
    await assert.rejects(readFile(path.join(isolatedHome, "config.toml"), "utf8"));
    await assert.rejects(
      readFile(path.join(isolatedHome, "skills", "personal", "SKILL.md"), "utf8"),
    );

    const config = isolatedCodexConfigArgs(isolatedHome);
    assert.ok(config.includes("project_root_markers=[]"));
    assert.ok(config.includes("project_doc_max_bytes=0"));
    assert.doesNotMatch(JSON.stringify(config), /source-home/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("triagem usa o modelo econômico configurado e exige cobertura exata", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "support-triage-agent-"));
  const invocations: string[][] = [];
  let duplicate = false;
  let relatedSuggestionId: string | null = "suggestion-1";
  const runner = new CodexSupportAgent(
    {
      cwd: temporary,
      dataDir: path.join(temporary, "runs"),
      attachmentsRoot: path.join(temporary, "attachments"),
      environment: { HOME: temporary, PATH: "/usr/bin:/bin" },
    },
    async ({ argv }) => {
      invocations.push(argv);
      const outputFlag = argv.indexOf("--output-last-message");
      await writeFile(
        argv[outputFlag + 1] as string,
        JSON.stringify({
          groups: [
            {
              messageIds: duplicate ? ["message-1", "message-1"] : ["message-1", "message-2"],
              kind: "demand",
              suggestedAction: "create",
              relatedTicketId: null,
              relatedSuggestionId,
              title: "Dúvida sobre total de clientes",
              summary: "O cliente questionou a composição da métrica.",
              affectedEcommerce: null,
              categories: {
                contactReason: ["Dúvida"],
                productArea: ["Dashboard"],
                platform: [],
                symptom: ["Dados incorretos"],
              },
              reason: "As duas mensagens tratam da mesma métrica.",
              confidence: 0.92,
            },
          ],
        }),
      );
      return { exitCode: 0, stderr: "" };
    },
  );
  const input: TriageAnalysisInput = {
    accountName: "Cliente",
    accountType: "ecommerce",
    groupName: "Suporte Cliente",
    knownEcommerces: [],
    candidateMessageIds: ["message-1", "message-2"],
    messages: ["message-1", "message-2"].map((id, index) => ({
      id,
      author: "Cliente",
      role: "external" as const,
      timestampUtc: `2026-07-18T10:0${index}:00.000Z`,
      text: index ? "E recorrentes mais novos não fecha." : "Como funciona total de clientes?",
      attachments: [],
      quotedMessageId: null,
    })),
    openTickets: [],
    pendingSuggestions: [{
      id: "suggestion-1",
      title: "Dúvida em andamento",
      summary: "O cliente iniciou a dúvida sobre a métrica.",
      suggestedAction: "create",
      suggestedTicketId: null,
      lastMessageAt: "2026-07-18T09:59:00.000Z",
    }],
  };

  try {
    await runner.triage(input, "gpt-5.4-mini");
    const argv = invocations[0] ?? [];
    assert.equal(argv[argv.indexOf("--model") + 1], "gpt-5.4-mini");
    assert.ok(argv.includes("--ignore-user-config"));
    assert.ok(argv.includes("--ignore-rules"));

    relatedSuggestionId = "suggestion-fora-do-contexto";
    await assert.rejects(
      runner.triage(input, "gpt-5.4-mini"),
      /sugestão fora do contexto permitido/i,
    );

    relatedSuggestionId = "suggestion-1";
    duplicate = true;
    await assert.rejects(
      runner.triage(input, "gpt-5.4-mini"),
      /repetiu a mensagem/,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("triagem preserva a ordem global e aceita somente grupos contíguos", async () => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "support-triage-order-agent-"),
  );
  let groupedMessageIds = [
    ["message-1", "message-2"],
    ["message-3", "message-4"],
  ];
  const runner = new CodexSupportAgent(
    {
      cwd: temporary,
      dataDir: path.join(temporary, "runs"),
      attachmentsRoot: path.join(temporary, "attachments"),
      environment: { HOME: temporary, PATH: "/usr/bin:/bin" },
    },
    async ({ argv }) => {
      const outputFlag = argv.indexOf("--output-last-message");
      await writeFile(
        argv[outputFlag + 1] as string,
        JSON.stringify({
          groups: groupedMessageIds.map((messageIds, index) => ({
            messageIds,
            kind: "demand",
            suggestedAction: "create",
            relatedTicketId: null,
            relatedSuggestionId: null,
            title: `Assunto ${index + 1}`,
            summary: `Resumo do assunto ${index + 1}.`,
            affectedEcommerce: null,
            categories: {
              contactReason: ["Dúvida"],
              productArea: ["Dashboard"],
              platform: [],
              symptom: [],
            },
            reason: "As mensagens formam um assunto contínuo.",
            confidence: 0.9,
          })),
        }),
      );
      return { exitCode: 0, stderr: "" };
    },
  );
  const input: TriageAnalysisInput = {
    accountName: "Cliente",
    accountType: "ecommerce",
    groupName: "Suporte Cliente",
    knownEcommerces: [],
    candidateMessageIds: [
      "message-1",
      "message-2",
      "message-3",
      "message-4",
    ],
    messages: ["message-1", "message-2", "message-3", "message-4"].map(
      (id, index) => ({
        id,
        author: "Cliente",
        role: "external" as const,
        timestampUtc: `2026-07-18T10:0${index}:00.000Z`,
        text: `Mensagem ${index + 1}`,
        attachments: [],
        quotedMessageId: null,
      }),
    ),
    openTickets: [],
    pendingSuggestions: [],
  };

  try {
    const valid = await runner.triage(input, "gpt-5.4-mini");
    assert.deepEqual(
      valid.groups.map((group) => group.messageIds),
      [
        ["message-1", "message-2"],
        ["message-3", "message-4"],
      ],
    );

    groupedMessageIds = [
      ["message-1", "message-3"],
      ["message-2", "message-4"],
    ];
    await assert.rejects(
      runner.triage(input, "gpt-5.4-mini"),
      /segmento contíguo/,
    );

    groupedMessageIds = [
      ["message-3", "message-4"],
      ["message-1", "message-2"],
    ];
    await assert.rejects(
      runner.triage(input, "gpt-5.4-mini"),
      /alterou a ordem da conversa/,
    );

    groupedMessageIds = [
      ["message-2", "message-1"],
      ["message-3", "message-4"],
    ];
    await assert.rejects(
      runner.triage(input, "gpt-5.4-mini"),
      /alterou a ordem da conversa/,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("triagem preserva 50 candidatos, limita contexto e prioriza seu orçamento e imagens", async () => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "support-triage-context-agent-"),
  );
  const attachmentsRoot = path.join(temporary, "attachments");
  await mkdir(attachmentsRoot, { recursive: true });
  const candidateImage = path.join(attachmentsRoot, "candidate.png");
  await writeFile(candidateImage, "candidate");
  const contextImages = await Promise.all(
    Array.from({ length: 5 }, async (_, index) => {
      const image = path.join(attachmentsRoot, `context-${index}.png`);
      await writeFile(image, `context-${index}`);
      return image;
    }),
  );
  const candidateIds = Array.from(
    { length: 50 },
    (_, index) => `candidate-${index + 1}`,
  );
  let boundedInput: TriageAnalysisInput | null = null;
  let imageArguments: string[] = [];
  let firstPreparedImage = "";
  const runner = new CodexSupportAgent(
    {
      cwd: temporary,
      dataDir: path.join(temporary, "runs"),
      attachmentsRoot,
      environment: { HOME: temporary, PATH: "/usr/bin:/bin" },
    },
    async ({ argv, stdin }) => {
      const match = stdin.match(
        /<DADOS_NAO_CONFIAVEIS>\n([\s\S]+)\n<\/DADOS_NAO_CONFIAVEIS>/,
      );
      assert.ok(match?.[1]);
      boundedInput = JSON.parse(match[1]) as TriageAnalysisInput;
      imageArguments = argv
        .map((value, index) =>
          argv[index - 1] === "--image" ? value : null,
        )
        .filter((value): value is string => Boolean(value));
      if (imageArguments[0]) {
        firstPreparedImage = await readFile(imageArguments[0], "utf8");
      }
      const outputFlag = argv.indexOf("--output-last-message");
      await writeFile(
        argv[outputFlag + 1] as string,
        JSON.stringify({
          groups: [
            {
              messageIds: candidateIds,
              kind: "demand",
              suggestedAction: "create",
              relatedTicketId: null,
              relatedSuggestionId: null,
              title: "Demanda agrupada",
              summary: "As mensagens candidatas formam uma demanda.",
              affectedEcommerce: null,
              categories: {
                contactReason: ["Dúvida"],
                productArea: ["Dashboard"],
                platform: [],
                symptom: [],
              },
              reason: "Cobertura integral dos candidatos.",
              confidence: 0.9,
            },
          ],
        }),
      );
      return { exitCode: 0, stderr: "" };
    },
  );
  const contexts = Array.from({ length: 25 }, (_, index) => ({
    id: `context-${index + 1}`,
    author: "Suporte",
    role: "staff" as const,
    timestampUtc: `2026-07-18T09:${String(index).padStart(2, "0")}:00.000Z`,
    text: "x".repeat(8_000),
    attachments:
      index >= 20
        ? [
            {
              kind: "image" as const,
              fileName: `context-${index - 20}.png`,
              localPath: contextImages[index - 20],
              extractedText: "y".repeat(16_000),
            },
          ]
        : [],
    quotedMessageId: null,
  }));
  const candidates = candidateIds.map((id, index) => ({
    id,
    author: "Cliente",
    role: "external" as const,
    timestampUtc: `2026-07-18T10:${String(index).padStart(2, "0")}:00.000Z`,
    text: `Texto prioritário ${index + 1}`,
    attachments:
      index === 49
        ? [
            {
              kind: "image" as const,
              fileName: "candidate.png",
              localPath: candidateImage,
              extractedText: "anexo candidato prioritário",
            },
          ]
        : [],
    quotedMessageId: null,
  }));

  try {
    await runner.triage(
      {
        accountName: "Cliente",
        accountType: "ecommerce",
        groupName: "Suporte Cliente",
        knownEcommerces: [],
        candidateMessageIds: candidateIds,
        messages: [...contexts, ...candidates],
        openTickets: [],
        pendingSuggestions: Array.from({ length: 35 }, (_, index) => ({
          id: `suggestion-${index + 1}-${"i".repeat(600)}`,
          title: "t".repeat(2_500),
          summary: "s".repeat(5_000),
          suggestedAction: "create" as const,
          suggestedTicketId: `ticket-${"x".repeat(600)}`,
          lastMessageAt: `2026-07-18T08:${String(index).padStart(2, "0")}:00.000Z`,
        })),
      },
      "gpt-5.4-mini",
    );
    const receivedInput = boundedInput as TriageAnalysisInput | null;
    assert.ok(receivedInput);
    assert.deepEqual(receivedInput.candidateMessageIds, candidateIds);
    assert.equal(receivedInput.pendingSuggestions.length, 30);
    assert.equal(receivedInput.pendingSuggestions[0]?.id.length, 500);
    assert.equal(receivedInput.pendingSuggestions[0]?.title.length, 2_000);
    assert.equal(receivedInput.pendingSuggestions[0]?.summary.length, 4_000);
    assert.equal(receivedInput.pendingSuggestions[0]?.suggestedTicketId?.length, 500);
    assert.equal(receivedInput.messages.length, 70);
    assert.equal(
      receivedInput.messages.filter((message) => message.id.startsWith("context-"))
        .length,
      20,
    );
    const boundedCandidate = receivedInput.messages.find(
      (message) => message.id === "candidate-50",
    );
    assert.equal(boundedCandidate?.text, "Texto prioritário 50");
    assert.equal(
      boundedCandidate?.attachments[0]?.extractedText,
      "anexo candidato prioritário",
    );
    assert.equal(
      receivedInput.messages
        .filter((message) => message.id.startsWith("context-"))
        .some((message) => message.text === null),
      true,
    );
    assert.match(
      imageArguments[0] ?? "",
      /threadmark-codex-.*image-1\.png/,
    );
    assert.equal(firstPreparedImage, "candidate");
    assert.equal(imageArguments.length, 5);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("triagem falha antes da execução quando um candidato não possui mensagem", async () => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "support-triage-missing-agent-"),
  );
  let executions = 0;
  const runner = new CodexSupportAgent(
    {
      cwd: temporary,
      dataDir: path.join(temporary, "runs"),
      environment: { HOME: temporary, PATH: "/usr/bin:/bin" },
    },
    async () => {
      executions += 1;
      return { exitCode: 0, stderr: "" };
    },
  );

  try {
    await assert.rejects(
      runner.triage(
        {
          accountName: "Cliente",
          accountType: "ecommerce",
          groupName: "Suporte Cliente",
          knownEcommerces: [],
          candidateMessageIds: ["present", "missing"],
          messages: [
            {
              id: "present",
              author: "Cliente",
              role: "external",
              timestampUtc: "2026-07-18T10:00:00.000Z",
              text: "Mensagem presente.",
              attachments: [],
              quotedMessageId: null,
            },
          ],
          openTickets: [],
          pendingSuggestions: [],
        },
        "gpt-5.4-mini",
      ),
      /candidato sem mensagem: missing/,
    );
    assert.equal(executions, 0);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
