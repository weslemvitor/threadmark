import { spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildInvestigationThreadPrompt,
  buildSupportPrompt,
  buildTriagePrompt,
} from "./prompt.js";
import {
  parseInvestigationTurnResult,
  parseSupportAnalysis,
  triageAnalysisSchema,
} from "./validation.js";
import type {
  AnalysisMessage,
  InvestigationThreadInput,
  InvestigationTurnResult,
  SupportAnalysis,
  SupportAnalysisInput,
  TriageAnalysis,
  TriageAnalysisInput,
} from "./types.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const defaultSchemaPath = path.join(moduleDir, "support-analysis.schema.json");
const defaultTurnSchemaPath = path.join(
  moduleDir,
  "investigation-turn.schema.json",
);
const defaultTriageSchemaPath = path.join(moduleDir, "triage-analysis.schema.json");

export interface CodexRunnerOptions {
  codexBin?: string;
  cwd?: string;
  dataDir?: string;
  schemaPath?: string;
  turnSchemaPath?: string;
  triageSchemaPath?: string;
  attachmentsRoot?: string;
  timeoutMs?: number;
  triageTimeoutMs?: number;
  environment?: CodexEnvironment;
}

export interface ProcessResult {
  exitCode: number;
  stderr: string;
}

type ProcessExecutor = (args: {
  executable: string;
  argv: string[];
  stdin: string;
  cwd: string;
  timeoutMs: number;
  env: CodexEnvironment;
  signal?: AbortSignal;
}) => Promise<ProcessResult>;

type RunnerMode = "automatic" | "deep" | "triage";
export type CodexEnvironment = Record<string, string | undefined>;

const SAFE_CODEX_ENVIRONMENT_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "TZ",
  "CODEX_HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;

const UNSAFE_EXECUTION_ENVIRONMENT_KEYS = new Set([
  "BASH_ENV",
  "BUN_OPTIONS",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "ENV",
  "GIT_SSH_COMMAND",
  "LD_PRELOAD",
  "NODE_OPTIONS",
  "PERL5OPT",
  "PROMPT_COMMAND",
  "PYTHONPATH",
  "RUBYOPT",
  "ZDOTDIR",
]);

const INPUT_LIMITS: Record<RunnerMode, {
  maxMessages: number;
  conversationCharacters: number;
  maxSentResponses: number;
  sentResponseCharacters: number;
  maxResolvedPrecedents: number;
  resolvedPrecedentCharacters: number;
}> = {
  automatic: {
    maxMessages: 50,
    conversationCharacters: 160_000,
    maxSentResponses: 30,
    sentResponseCharacters: 60_000,
    maxResolvedPrecedents: 20,
    resolvedPrecedentCharacters: 100_000,
  },
  deep: {
    maxMessages: 100,
    conversationCharacters: 320_000,
    maxSentResponses: 50,
    sentResponseCharacters: 100_000,
    maxResolvedPrecedents: 30,
    resolvedPrecedentCharacters: 160_000,
  },
  triage: {
    maxMessages: 70,
    conversationCharacters: 100_000,
    maxSentResponses: 0,
    sentResponseCharacters: 0,
    maxResolvedPrecedents: 0,
    resolvedPrecedentCharacters: 0,
  },
};

const TRIAGE_MAX_CANDIDATE_MESSAGES = 50;
const TRIAGE_MAX_CONTEXT_MESSAGES = 20;
const MAX_ISOLATED_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_ISOLATED_IMAGE_TOTAL_BYTES = 25 * 1024 * 1024;
const ISOLATED_DISABLED_FEATURES = [
  "apps",
  "browser_use",
  "browser_use_external",
  "code_mode_host",
  "computer_use",
  "goals",
  "hooks",
  "image_generation",
  "in_app_browser",
  "memories",
  "multi_agent",
  "plugins",
  "shell_tool",
  "tool_suggest",
  "unified_exec",
  "workspace_dependencies",
] as const;
const CODEX_SYSTEM_SKILLS = [
  "imagegen",
  "openai-docs",
  "plugin-creator",
  "skill-creator",
  "skill-installer",
] as const;

export class CodexRunAbortedError extends Error {
  constructor() {
    super("Investigação Codex cancelada pelo encerramento do serviço.");
    this.name = "CodexRunAbortedError";
  }
}

export function buildCodexEnvironment(
  source: CodexEnvironment,
  additionalKeys: string[] = [],
): CodexEnvironment {
  const allowed = new Set<string>([
    ...SAFE_CODEX_ENVIRONMENT_KEYS,
    ...additionalKeys,
  ]);
  const environment: CodexEnvironment = {};

  for (const key of allowed) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (UNSAFE_EXECUTION_ENVIRONMENT_KEYS.has(key)) continue;
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }

  return environment;
}

export function isolatedCodexConfigArgs(codexHome: string): string[] {
  const skillsConfig = `skills.config=[${CODEX_SYSTEM_SKILLS.map((skill) => {
    const skillPath = path.join(
      codexHome,
      "skills",
      ".system",
      skill,
      "SKILL.md",
    );
    return `{path=${JSON.stringify(skillPath)},enabled=false}`;
  }).join(",")}]`;

  return [
    "-c",
    'approval_policy="never"',
    "-c",
    'web_search="disabled"',
    "-c",
    "mcp_servers={}",
    "-c",
    'shell_environment_policy.inherit="none"',
    "-c",
    "project_root_markers=[]",
    "-c",
    "project_doc_max_bytes=0",
    "-c",
    skillsConfig,
    ...ISOLATED_DISABLED_FEATURES.flatMap((feature) => [
      "--disable",
      feature,
    ]),
  ];
}

export async function prepareIsolatedCodexHome(
  runDir: string,
  sourceCodexHome: string | null,
): Promise<string> {
  const codexHome = path.join(runDir, "codex-home");
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await chmod(codexHome, 0o700);
  if (!sourceCodexHome) return codexHome;

  try {
    const sourceRoot = await realpath(sourceCodexHome);
    const sourceAuth = await realpath(path.join(sourceRoot, "auth.json"));
    const relativeAuth = path.relative(sourceRoot, sourceAuth);
    if (relativeAuth.startsWith("..") || path.isAbsolute(relativeAuth)) {
      return codexHome;
    }
    const targetAuth = path.join(codexHome, "auth.json");
    await copyFile(sourceAuth, targetAuth);
    await chmod(targetAuth, 0o600);
  } catch {
    // Keychain-backed sessions may not expose auth.json; the CLI decides availability.
  }
  return codexHome;
}

function truncateText(value: string, maxCharacters: number): string {
  if (value.length <= maxCharacters) return value;
  const marker = "\n...[conteúdo truncado pelo limite do runner]...\n";
  if (maxCharacters <= marker.length) return value.slice(0, maxCharacters);
  const available = maxCharacters - marker.length;
  const startLength = Math.ceil(available / 2);
  const endLength = available - startLength;
  return `${value.slice(0, startLength)}${marker}${
    endLength ? value.slice(-endLength) : ""
  }`;
}

function boundConversationState(
  state: SupportAnalysisInput["conversationState"],
): SupportAnalysisInput["conversationState"] {
  return {
    lastExternalMessageAt: state.lastExternalMessageAt
      ? truncateText(state.lastExternalMessageAt, 100)
      : null,
    lastSentResponseAt: state.lastSentResponseAt
      ? truncateText(state.lastSentResponseAt, 100)
      : null,
    unansweredExternalMessageIds: state.unansweredExternalMessageIds
      .slice(-50)
      .map((id) => truncateText(id, 500)),
    hasUnansweredExternalMessages: state.hasUnansweredExternalMessages,
  };
}

function boundResolvedPrecedent(
  precedent: SupportAnalysisInput["resolvedPrecedents"][number],
  budget: { remaining: number },
): SupportAnalysisInput["resolvedPrecedents"][number] {
  const requiredContent = (value: string, limit: number): string =>
    consumeTextBudget(value, limit, budget) ??
    "[conteúdo omitido pelo limite do runner]";
  const optionalContent = (value: string | null, limit: number): string | null =>
    value === null ? null : requiredContent(value, limit);

  return {
    ticketId: truncateText(precedent.ticketId, 500),
    title: requiredContent(precedent.title, 2_000),
    summary: requiredContent(precedent.summary, 4_000),
    resolvedAt: precedent.resolvedAt
      ? truncateText(precedent.resolvedAt, 100)
      : null,
    affectedStore: precedent.affectedStore
      ? {
          id: truncateText(precedent.affectedStore.id, 500),
          name: truncateText(precedent.affectedStore.name, 500),
        }
      : null,
    categories: precedent.categories
      .slice(0, 30)
      .map((category) => truncateText(category, 200)),
    resolution: {
      summary: requiredContent(precedent.resolution.summary, 8_000),
      rootCause: optionalContent(precedent.resolution.rootCause, 4_000),
      outcome: optionalContent(precedent.resolution.outcome, 4_000),
      validatedAt: truncateText(precedent.resolution.validatedAt, 100),
    },
    finalResponse: optionalContent(precedent.finalResponse, 8_000),
  };
}

function consumeTextBudget(
  value: string | null,
  perItemLimit: number,
  budget: { remaining: number },
): string | null {
  if (value === null) return null;
  const allowed = Math.min(perItemLimit, budget.remaining);
  if (allowed <= 0) return null;
  const bounded = truncateText(value, allowed);
  budget.remaining -= bounded.length;
  return bounded;
}

function boundSupportInput(
  input: SupportAnalysisInput,
  mode: RunnerMode,
): SupportAnalysisInput {
  const limits = INPUT_LIMITS[mode];
  const conversationBudget = { remaining: limits.conversationCharacters };
  const selectedMessages = input.messages.slice(-limits.maxMessages);
  const messages = selectedMessages
    .toReversed()
    .map((message) => ({
      ...message,
      author: truncateText(message.author, 500),
      text: consumeTextBudget(message.text, 8_000, conversationBudget),
      attachments: message.attachments.slice(0, 10).map((attachment) => ({
        ...attachment,
        localPath: mode === "deep" ? attachment.localPath : null,
        fileName: attachment.fileName
          ? truncateText(attachment.fileName, 500)
          : null,
        extractedText: consumeTextBudget(
          attachment.extractedText,
          16_000,
          conversationBudget,
        ),
      })),
    }))
    .reverse();

  const sentResponseBudget = { remaining: limits.sentResponseCharacters };
  const sentResponses = input.sentResponses
    .slice(-limits.maxSentResponses)
    .map((response) => ({
      id: truncateText(response.id, 500),
      messageId: response.messageId
        ? truncateText(response.messageId, 500)
        : null,
      body:
        consumeTextBudget(response.body, 8_000, sentResponseBudget) ??
        "[resposta omitida pelo limite do runner]",
      sentAt: truncateText(response.sentAt, 100),
    }));
  const precedentBudget = { remaining: limits.resolvedPrecedentCharacters };
  const resolvedPrecedents = input.resolvedPrecedents
    .slice(0, limits.maxResolvedPrecedents)
    .map((precedent) => boundResolvedPrecedent(precedent, precedentBudget));

  return {
    ...input,
    operatorInstructions: input.operatorInstructions
      ? truncateText(input.operatorInstructions, 4_000)
      : input.operatorInstructions,
    accountName: truncateText(input.accountName, 500),
    groupName: truncateText(input.groupName, 500),
    knownEcommerces: input.knownEcommerces
      .slice(0, 250)
      .map((name) => truncateText(name, 500)),
    conversationState: boundConversationState(input.conversationState),
    messages,
    sentResponses,
    openTickets: input.openTickets.slice(0, 30).map((ticket) => ({
      id: truncateText(ticket.id, 500),
      title: truncateText(ticket.title, 2_000),
      summary: truncateText(ticket.summary, 4_000),
      status: truncateText(ticket.status, 100),
    })),
    resolvedPrecedents,
  };
}

function boundTriageInput(input: TriageAnalysisInput): TriageAnalysisInput {
  const limits = INPUT_LIMITS.triage;
  if (input.candidateMessageIds.length > TRIAGE_MAX_CANDIDATE_MESSAGES) {
    throw new Error(
      `Triagem Codex aceita no máximo ${TRIAGE_MAX_CANDIDATE_MESSAGES} mensagens candidatas por execução.`,
    );
  }

  const candidateIds = new Set(input.candidateMessageIds);
  if (candidateIds.size !== input.candidateMessageIds.length) {
    throw new Error("Triagem Codex recebeu id candidato repetido.");
  }
  const suggestionIds = input.pendingSuggestions.map((suggestion) => suggestion.id);
  if (new Set(suggestionIds).size !== suggestionIds.length) {
    throw new Error("Triagem Codex recebeu id de sugestão pendente repetido.");
  }
  const messagesById = new Map(
    input.messages.map((message) => [message.id, message] as const),
  );
  const missingCandidates = input.candidateMessageIds.filter(
    (messageId) => !messagesById.has(messageId),
  );
  if (missingCandidates.length) {
    throw new Error(
      `Triagem Codex recebeu candidato sem mensagem: ${missingCandidates.join(", ")}.`,
    );
  }

  const candidateMessages = input.candidateMessageIds.map(
    (messageId) => messagesById.get(messageId)!,
  );
  const internalCandidate = candidateMessages.find(
    (message) => message.role === "staff" || message.role === "self",
  );
  if (internalCandidate) {
    throw new Error(
      `Triagem Codex recebeu mensagem interna como candidata: ${internalCandidate.id}.`,
    );
  }

  const contextLimit = Math.min(
    TRIAGE_MAX_CONTEXT_MESSAGES,
    limits.maxMessages - candidateMessages.length,
  );
  const contextMessages: AnalysisMessage[] = [];
  const selectedContextIds = new Set<string>();
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const message = input.messages[index]!;
    if (candidateIds.has(message.id) || selectedContextIds.has(message.id)) {
      continue;
    }
    selectedContextIds.add(message.id);
    contextMessages.push(message);
    if (contextMessages.length >= contextLimit) break;
  }
  contextMessages.reverse();

  const conversationBudget = { remaining: limits.conversationCharacters };
  const boundMessage = (message: AnalysisMessage): AnalysisMessage => ({
    ...message,
    author: truncateText(message.author, 500),
    text: consumeTextBudget(message.text, 8_000, conversationBudget),
    attachments: message.attachments.slice(0, 10).map((attachment) => ({
      ...attachment,
      localPath: null,
      fileName: attachment.fileName
        ? truncateText(attachment.fileName, 500)
        : null,
      extractedText: consumeTextBudget(
        attachment.extractedText,
        16_000,
        conversationBudget,
      ),
    })),
  });
  const boundedById = new Map<string, AnalysisMessage>();
  for (const message of candidateMessages) {
    boundedById.set(message.id, boundMessage(message));
  }
  for (const message of contextMessages) {
    boundedById.set(message.id, boundMessage(message));
  }
  const messages: AnalysisMessage[] = [];
  const appended = new Set<string>();
  for (const message of input.messages) {
    const bounded = boundedById.get(message.id);
    if (!bounded || appended.has(message.id)) continue;
    messages.push(bounded);
    appended.add(message.id);
  }

  return {
    ...input,
    accountName: truncateText(input.accountName, 500),
    groupName: truncateText(input.groupName, 500),
    knownEcommerces: input.knownEcommerces
      .slice(0, 250)
      .map((name) => truncateText(name, 500)),
    candidateMessageIds: [...input.candidateMessageIds],
    messages,
    openTickets: input.openTickets.slice(0, 30).map((ticket) => ({
      id: truncateText(ticket.id, 500),
      title: truncateText(ticket.title, 2_000),
      summary: truncateText(ticket.summary, 4_000),
      status: truncateText(ticket.status, 100),
    })),
    pendingSuggestions: input.pendingSuggestions.slice(0, 30).map((suggestion) => ({
      id: truncateText(suggestion.id, 500),
      title: truncateText(suggestion.title, 2_000),
      summary: truncateText(suggestion.summary, 4_000),
      suggestedAction: suggestion.suggestedAction,
      suggestedTicketId: suggestion.suggestedTicketId
        ? truncateText(suggestion.suggestedTicketId, 500)
        : null,
      lastMessageAt: truncateText(suggestion.lastMessageAt, 100),
    })),
  };
}

const defaultProcessExecutor: ProcessExecutor = ({
  executable,
  argv,
  stdin,
  cwd,
  timeoutMs,
  env,
  signal,
}) =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, argv, {
      cwd,
      env: env as NodeJS.ProcessEnv,
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      child.kill("SIGTERM");
      finish();
      reject(new CodexRunAbortedError());
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish();
      reject(new Error(`Codex excedeu o limite de ${timeoutMs}ms.`));
    }, timeoutMs);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-16_000);
    });
    child.once("error", (error) => {
      finish();
      reject(error);
    });
    child.once("close", (code) => {
      finish();
      resolve({ exitCode: code ?? 1, stderr });
    });
    child.stdin.end(stdin);
  });

export class CodexSupportAgent {
  private readonly options: Required<CodexRunnerOptions>;

  constructor(
    options: CodexRunnerOptions = {},
    private readonly executeProcess: ProcessExecutor = defaultProcessExecutor,
  ) {
    const cwd = options.cwd ?? process.cwd();
    this.options = {
      codexBin:
        options.codexBin ??
        process.env.CODEX_BIN ??
        "/Applications/ChatGPT.app/Contents/Resources/codex",
      cwd,
      dataDir: options.dataDir ?? path.join(cwd, ".data", "agent-runs"),
      schemaPath: options.schemaPath ?? defaultSchemaPath,
      turnSchemaPath: options.turnSchemaPath ?? defaultTurnSchemaPath,
      triageSchemaPath: options.triageSchemaPath ?? defaultTriageSchemaPath,
      attachmentsRoot:
        options.attachmentsRoot ?? path.join(cwd, ".data", "attachments"),
      timeoutMs: options.timeoutMs ?? 300_000,
      triageTimeoutMs: options.triageTimeoutMs ?? 90_000,
      environment: options.environment ?? process.env,
    };
  }

  async analyse(
    input: SupportAnalysisInput,
    model = "default",
    signal?: AbortSignal,
  ): Promise<SupportAnalysis> {
    const boundedInput = boundSupportInput(input, "automatic");
    const raw = await this.executeStructuredRun({
      input: boundedInput,
      imageInput: input,
      prompt: buildSupportPrompt(boundedInput),
      schemaPath: this.options.schemaPath,
      mode: "automatic",
      model,
      signal,
    });
    return parseSupportAnalysis(raw, boundedInput);
  }

  async investigateThread(
    input: InvestigationThreadInput,
    model = "default",
    signal?: AbortSignal,
  ): Promise<InvestigationTurnResult> {
    const boundedInput: InvestigationThreadInput = {
      ...input,
      ticket: boundSupportInput(input.ticket, "deep"),
    };
    const raw = await this.executeStructuredRun({
      input: boundedInput.ticket,
      imageInput: input.ticket,
      prompt: buildInvestigationThreadPrompt(boundedInput),
      schemaPath: this.options.turnSchemaPath,
      mode: "deep",
      model,
      signal,
    });
    return parseInvestigationTurnResult(raw, boundedInput);
  }

  async triage(
    input: TriageAnalysisInput,
    model: string,
    signal?: AbortSignal,
  ): Promise<TriageAnalysis> {
    const boundedInput = boundTriageInput(input);
    const raw = await this.executeStructuredRun({
      input: boundedInput,
      imageInput: input,
      prompt: buildTriagePrompt(boundedInput),
      schemaPath: this.options.triageSchemaPath,
      mode: "triage",
      model,
      signal,
    });
    const result = triageAnalysisSchema.parse(raw);
    assertExactTriageCoverage(boundedInput, result);
    return result;
  }

  private async executeStructuredRun(input: {
    input: unknown;
    imageInput: {
      messages: AnalysisMessage[];
      candidateMessageIds?: string[];
    };
    prompt: string;
    schemaPath: string;
    mode: RunnerMode;
    model?: string;
    signal?: AbortSignal;
  }): Promise<unknown> {
    const runDir = await mkdtemp(path.join(os.tmpdir(), "threadmark-codex-"));
    await chmod(runDir, 0o700);
    const outputPath = path.join(runDir, "analysis.json");
    const promptPath = path.join(runDir, "input.json");
    await writeFile(promptPath, JSON.stringify(input.input, null, 2), {
      mode: 0o600,
    });

    try {
      const trustedImages = await this.trustedImagePaths(
        input.imageInput,
        input.mode,
      );
      const imagePaths = await this.copyIsolatedImages(trustedImages, runDir);
      const childEnvironment = buildCodexEnvironment(this.options.environment);
      const isolatedHome = path.join(runDir, "home");
      await mkdir(isolatedHome, { recursive: true, mode: 0o700 });
      const configuredCodexHome = this.options.environment.CODEX_HOME;
      const originalHome = this.options.environment.HOME;
      childEnvironment.HOME = isolatedHome;
      childEnvironment.XDG_CONFIG_HOME = path.join(isolatedHome, ".config");
      childEnvironment.XDG_CACHE_HOME = path.join(isolatedHome, ".cache");
      childEnvironment.XDG_DATA_HOME = path.join(
        isolatedHome,
        ".local",
        "share",
      );
      const sourceCodexHome = configuredCodexHome ??
        (originalHome ? path.join(originalHome, ".codex") : null);
      childEnvironment.CODEX_HOME = await prepareIsolatedCodexHome(
        runDir,
        sourceCodexHome,
      );
      const selectedModel = normaliseCodexModel(input.model);
      const result = await this.executeProcess({
        executable: this.options.codexBin,
        argv: [
          "exec",
          "--ephemeral",
          "--strict-config",
          "--ignore-user-config",
          "--ignore-rules",
          "--skip-git-repo-check",
          ...isolatedCodexConfigArgs(
            childEnvironment.CODEX_HOME as string,
          ),
          ...(selectedModel ? ["--model", selectedModel] : []),
          "--sandbox",
          "read-only",
          "--color",
          "never",
          "--output-schema",
          input.schemaPath,
          "--output-last-message",
          outputPath,
          ...imagePaths.flatMap((imagePath) => ["--image", imagePath]),
          "-",
        ],
        stdin: input.prompt,
        cwd: runDir,
        timeoutMs:
          input.mode === "triage"
            ? this.options.triageTimeoutMs
            : this.options.timeoutMs,
        env: childEnvironment,
        signal: input.signal,
      });

      if (result.exitCode !== 0) {
        throw new Error(
          `Codex encerrou com codigo ${result.exitCode}: ${result.stderr || "sem detalhes"}`,
        );
      }

      const raw = await readFile(outputPath, "utf8");
      return JSON.parse(raw) as unknown;
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  }

  private async trustedImagePaths(
    input: {
      messages: AnalysisMessage[];
      candidateMessageIds?: string[];
    },
    mode: RunnerMode,
  ): Promise<string[]> {
    const configuredRoot = path.resolve(this.options.attachmentsRoot);
    let trustedRoot: string;

    try {
      trustedRoot = await realpath(configuredRoot);
    } catch {
      return [];
    }

    let messages = input.messages;
    if (mode === "triage" && input.candidateMessageIds?.length) {
      const messagesById = new Map(
        input.messages.map((message) => [message.id, message] as const),
      );
      const candidateIds = new Set(input.candidateMessageIds);
      messages = [
        ...input.candidateMessageIds.flatMap((messageId) => {
          const message = messagesById.get(messageId);
          return message ? [message] : [];
        }),
        ...input.messages.filter((message) => !candidateIds.has(message.id)),
      ];
    }

    const candidates = messages.flatMap((message) =>
      message.attachments
        .filter((attachment) => attachment.kind === "image" && attachment.localPath)
        .map((attachment) => attachment.localPath as string),
    );
    const accepted: string[] = [];

    for (const candidate of candidates) {
      if (accepted.length >= 5) break;

      try {
        const resolved = await realpath(path.resolve(candidate));
        const relative = path.relative(trustedRoot, resolved);
        if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
          accepted.push(resolved);
        }
      } catch {
        // A missing or untrusted attachment remains represented by metadata only.
      }
    }

    return [...new Set(accepted)];
  }

  private async copyIsolatedImages(
    imagePaths: string[],
    runDir: string,
  ): Promise<string[]> {
    const prepared: string[] = [];
    let totalBytes = 0;
    for (const [index, source] of imagePaths.entries()) {
      try {
        const metadata = await stat(source);
        if (
          !metadata.isFile() ||
          metadata.size > MAX_ISOLATED_IMAGE_BYTES ||
          totalBytes + metadata.size > MAX_ISOLATED_IMAGE_TOTAL_BYTES
        ) {
          continue;
        }
        const extension = path.extname(source).slice(0, 12).toLowerCase();
        const target = path.join(runDir, `image-${index + 1}${extension}`);
        await copyFile(source, target);
        await chmod(target, 0o600);
        totalBytes += metadata.size;
        prepared.push(target);
      } catch {
        // Anexos indisponíveis continuam representados apenas pelos metadados sanitizados.
      }
    }
    return prepared;
  }
}

function normaliseCodexModel(value: string | undefined): string | null {
  const model = value?.trim();
  return !model || model === "default" ? null : model;
}

function assertExactTriageCoverage(
  input: TriageAnalysisInput,
  result: TriageAnalysis,
): void {
  const expected = new Set(input.candidateMessageIds);
  const observed = new Set<string>();
  const allowedContext = new Set(
    input.messages
      .filter((message) => message.role === "staff" || message.role === "self")
      .map((message) => message.id),
  );
  const observedContext = new Set<string>();
  const allowedTickets = new Set(input.openTickets.map((ticket) => ticket.id));
  const allowedSuggestions = new Set(
    input.pendingSuggestions.map((suggestion) => suggestion.id),
  );

  for (const group of result.groups) {
    for (const messageId of group.contextMessageIds ?? []) {
      if (!allowedContext.has(messageId)) {
        throw new Error(
          `Triagem Codex devolveu contexto interno desconhecido: ${messageId}`,
        );
      }
      if (expected.has(messageId) || observedContext.has(messageId)) {
        throw new Error(
          `Triagem Codex repetiu ou misturou a mensagem de contexto: ${messageId}`,
        );
      }
      if (
        group.suggestedAction === "ignore" ||
        group.suggestedAction === "wait"
      ) {
        throw new Error(
          "Triagem Codex não pode associar contexto interno a ignore ou wait.",
        );
      }
      observedContext.add(messageId);
    }
    for (const messageId of group.messageIds) {
      if (!expected.has(messageId)) {
        throw new Error(`Triagem Codex devolveu mensagem desconhecida: ${messageId}`);
      }
      if (observed.has(messageId)) {
        throw new Error(`Triagem Codex repetiu a mensagem: ${messageId}`);
      }
      observed.add(messageId);
    }
    if (
      group.suggestedAction === "attach" &&
      group.relatedTicketId &&
      !allowedTickets.has(group.relatedTicketId)
    ) {
      throw new Error("Triagem Codex sugeriu um ticket fora do contexto permitido.");
    }
    if (
      group.relatedSuggestionId &&
      !allowedSuggestions.has(group.relatedSuggestionId)
    ) {
      throw new Error("Triagem Codex sugeriu uma sugestão fora do contexto permitido.");
    }
  }

  const missing = [...expected].filter((messageId) => !observed.has(messageId));
  if (missing.length) {
    throw new Error(`Triagem Codex omitiu ${missing.length} mensagem(ns).`);
  }

  let nextExpectedIndex = 0;
  for (const [groupIndex, group] of result.groups.entries()) {
    const expectedSegment = input.candidateMessageIds.slice(
      nextExpectedIndex,
      nextExpectedIndex + group.messageIds.length,
    );
    const firstMismatch = group.messageIds.findIndex(
      (messageId, messageIndex) => messageId !== expectedSegment[messageIndex],
    );
    if (firstMismatch !== -1) {
      throw new Error(
        `Triagem Codex alterou a ordem da conversa: o grupo ${groupIndex + 1} deve conter um segmento contíguo das mensagens candidatas.`,
      );
    }
    nextExpectedIndex += group.messageIds.length;
  }
}
