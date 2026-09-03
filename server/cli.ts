import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import QRCode from "qrcode";
import Database from "better-sqlite3";

import type { RuntimeQrResponse } from "../shared/contracts.js";
import {
  LocalAuthService,
  SetupChallengeService,
} from "./auth/index.js";
import { LocalAccessToken } from "./auth/local-access-token.js";
import { CodexSupportAgent } from "./agent/codex-runner.js";
import { InvestigationWorker } from "./agent/investigation-worker.js";
import { ConfiguredSupportAgent } from "./agent/provider-router.js";
import { AiProviderSettingsService } from "./agent/provider-settings.js";
import { createDatabase } from "./db/index.js";
import { SupportStore } from "./domain/index.js";
import { loadConfig } from "./runtime/config.js";
import {
  createLocalBackup,
  DEFAULT_LOCAL_BACKUP_RETENTION,
  listLocalBackups,
  restoreLocalBackup,
  validateLocalBackup,
} from "./runtime/backup.js";
import { hardenPrivateState } from "./runtime/private-state.js";
import { LocalSecretVault } from "./runtime/secret-vault.js";
import {
  LocalSettingsFile,
  mergeConfiguredIdentities,
} from "./runtime/local-settings.js";
import { RuntimeStateFile } from "./runtime/runtime-state.js";
import { runDoctor, type DoctorProbeState } from "./runtime/doctor.js";
import {
  requestWebBuildReload,
  webBuildReloadPath,
} from "./runtime/web-build-reload.js";
import { waitForWebBuildReady } from "./runtime/web-readiness.js";
import {
  inspectDaemonIdentity,
  requestDaemonShutdown,
  waitForDaemonReady,
  waitForDaemonStopped,
} from "./runtime/daemon-control.js";
import {
  getLaunchAgentStatus,
  installLaunchAgent,
  startInstalledLaunchAgent,
  uninstallLaunchAgent,
} from "./runtime/launch-agent.js";
import {
  configurationUrl,
  openLocalInterface,
  type ConfigurationSection,
} from "./runtime/open-interface.js";
import { updateConversationMonitoring } from "./triage/monitoring.js";
import {
  parseHistoryRescanPreviewArguments,
  previewHistoryRescan,
} from "./triage/history-rescan.js";
import { DeepToolExecutor } from "./tools/deep-tool-executor.js";
import { LocalToolService } from "./tools/local-tool-service.js";
import {
  createHeadlessHttpTransport,
  executeHeadlessCommand,
  isHeadlessCommand,
  type HeadlessTransport,
} from "./headless/cli.js";

await main().catch((error) => {
  console.error(`Erro: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const command = (process.argv[2] ?? "help").toLowerCase();
  if (isHeadlessCommand(command)) {
    await runHeadlessCommand(command);
    return;
  }
  switch (command) {
    case "-h":
    case "--help":
    case "help":
      printHelp();
      return;
    case "-v":
    case "--version":
    case "version":
      await printVersion();
      return;
    case "start":
    case "on":
      await start();
      return;
    case "stop":
    case "off":
      await stop();
      return;
    case "status":
      await status();
      return;
    case "open":
      await openWeb();
      return;
    case "configure":
      await configure();
      return;
    case "tools":
      await toolsCommand();
      return;
    case "doctor":
      await doctor();
      return;
    case "service":
      await serviceCommand();
      return;
    case "groups":
      listGroups();
      return;
    case "monitor":
      await setMonitored(true);
      return;
    case "unmonitor":
      await setMonitored(false);
      return;
    case "rescan":
      rescanHistory();
      return;
    case "staff:add":
      await updateStaff(true);
      return;
    case "staff:remove":
      await updateStaff(false);
      return;
    case "staff:list":
      await listStaff();
      return;
    case "agent:once":
      await runOneInvestigation();
      return;
    case "backup":
      await backup();
      return;
    case "backups":
      await listBackups();
      return;
    case "restore":
      await restoreBackup();
      return;
    case "security:harden":
      await hardenSecurity();
      return;
    case "setup-token":
      issueSetupToken();
      return;
    default:
      console.error(`Comando desconhecido: ${command}\n`);
      printHelp();
      process.exitCode = 1;
  }
}

async function runHeadlessCommand(command: string): Promise<void> {
  const config = loadConfig();
  const transport: HeadlessTransport = command === "capabilities"
    ? {
        request: async () => {
          throw new Error("A consulta de capacidades não acessa a API.");
        },
      }
    : createHeadlessHttpTransport({
        apiUrl: config.apiUrl,
        token: await new LocalAccessToken(config.localAccessTokenPath).ensure(),
      });
  const args = process.argv.slice(3);
  const result = await executeHeadlessCommand(command, args, transport, {
    invocationCwd: process.env.THREADMARK_INVOKE_CWD ?? process.cwd(),
  });
  const serialized = JSON.stringify(result, null, args.includes("--json") ? undefined : 2);
  if (result.ok) console.log(serialized);
  else {
    console.error(serialized);
    process.exitCode = 2;
  }
}

async function start(): Promise<void> {
  const config = loadConfig();
  const existingPid = await readPid(config.pidPath);
  const existingToken = await readLocalAccessToken(config.localAccessTokenPath);
  const existingDaemon = await inspectDaemonIdentity(config.apiUrl, {
    token: existingToken,
  });
  if (existingDaemon.state === "foreign") {
    throw new Error(existingDaemon.message);
  }
  if (existingDaemon.state === "unavailable") {
    throw new Error(
      `${existingDaemon.message} O Threadmark não abrirá o banco até confirmar que a porta está livre.`,
    );
  }
  if (existingDaemon.state === "threadmark") {
    if (!existingDaemon.authenticated || !existingDaemon.identity) {
      throw new Error(
        `${existingDaemon.message} O banco local não foi aberto por segurança.`,
      );
    }
    if (
      existingPid &&
      isProcessRunning(existingPid) &&
      existingPid !== existingDaemon.identity.pid
    ) {
      throw new Error(
        `A API autenticada usa o PID ${existingDaemon.identity.pid}, mas o arquivo local aponta para ${existingPid}. Nenhum processo foi alterado.`,
      );
    }
    console.log(`Threadmark já está rodando no PID ${existingDaemon.identity.pid}.`);
    if (config.startWeb) {
      try {
        await waitForWebBuildReady(config.webOrigin, { timeoutMs: 2_500 });
      } catch {
        console.log("Interface incompleta detectada; recarregando somente a Web UI.");
        await requestWebBuildReload(webBuildReloadPath(config.dataDir));
        await waitForWebBuildReady(config.webOrigin, { timeoutMs: 20_000 });
      }
    }
    await status();
    return;
  }
  if (existingPid && isProcessRunning(existingPid)) {
    throw new Error(
      `O PID ${existingPid} está ativo, mas não confirmou a API do Threadmark. O banco não foi aberto e o processo não foi alterado.`,
    );
  }
  if (existingPid) await rm(config.pidPath, { force: true });

  const localAccessToken = await new LocalAccessToken(
    config.localAccessTokenPath,
  ).ensure();
  const setupDatabase = createDatabase(config.databasePath);
  try {
    if (new LocalAuthService(setupDatabase).getSetupStatus().required) {
      const challenge = new SetupChallengeService(setupDatabase).issue();
      console.log("Código de configuração inicial (válido por 30 minutos):");
      console.log(challenge.token);
    }
  } finally {
    setupDatabase.close();
  }
  const logPath = path.join(config.logsDir, "daemon.log");
  const serviceStarted = await startInstalledLaunchAgent();
  const child = serviceStarted ? null : spawnServiceRunner(config.projectRoot);
  console.log(
    serviceStarted
      ? "Threadmark iniciando pelo serviço automático do macOS."
      : `Threadmark iniciando. Log: ${logPath}`,
  );

  if (process.env.THREADMARK_DESKTOP_START === "1") {
    await waitForDaemonReady({
      apiUrl: config.apiUrl,
      webOrigin: config.webOrigin,
      webEnabled: config.startWeb,
      timeoutMs: 20_000,
    });
    console.log(`Workspace local pronto em ${config.webOrigin}.`);
    return;
  }

  const runtime = new RuntimeStateFile(config.runtimeStatePath);
  const deadline = Date.now() + (config.whatsappEnabled ? 120_000 : 20_000);
  let lastQr: string | null = null;
  while (Date.now() < deadline) {
    await wait(1_000);
    if (child?.pid && !isProcessRunning(child.pid)) {
      throw new Error(`O processo encerrou durante a inicialização. Consulte ${logPath}.`);
    }
    const state = await runtime.read();
    if (!config.whatsappEnabled && state.pid) {
      await waitForDaemonReady({
        apiUrl: config.apiUrl,
        webOrigin: config.webOrigin,
        webEnabled: config.startWeb,
        timeoutMs: Math.max(1, deadline - Date.now()),
      });
      console.log(
        `Serviço local pronto em ${config.apiUrl}. WhatsApp desativado; investigação Codex ${config.agentEnabled ? "ativa" : "desativada"}.`,
      );
      return;
    }
    if (state.phase === "online") {
      await waitForDaemonReady({
        apiUrl: config.apiUrl,
        webOrigin: config.webOrigin,
        webEnabled: config.startWeb,
        timeoutMs: Math.max(1, deadline - Date.now()),
      });
      console.log(`Suporte On. Interface: ${config.webOrigin}`);
      return;
    }
    if (state.phase === "error") {
      throw new Error(state.lastError ?? `Falha ao iniciar. Consulte ${logPath}.`);
    }
    if (state.qrAvailable) {
      const qr = await fetchQr(config.apiUrl, localAccessToken);
      if (qr && qr !== lastQr) {
        lastQr = qr;
        console.log("Escaneie este QR no WhatsApp do número comercial:");
        console.log(await QRCode.toString(qr, { type: "terminal", small: true }));
      }
    }
  }
  console.log(`O processo continua ativo. Consulte o status ou o log em ${logPath}.`);
}

function spawnServiceRunner(projectRoot: string) {
  const tsxCli = path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const child = spawn(
    process.execPath,
    [tsxCli, path.join(projectRoot, "server", "service-runner.ts")],
    {
      cwd: projectRoot,
      env: process.env,
      detached: true,
      stdio: "ignore",
    },
  );
  child.unref();
  return child;
}

async function stop(): Promise<void> {
  const config = loadConfig();
  const pidFromFile = await readPid(config.pidPath);
  const token = await readLocalAccessToken(config.localAccessTokenPath);
  const daemon = await inspectDaemonIdentity(config.apiUrl, { token });
  if (daemon.state === "offline") {
    if (pidFromFile && isProcessRunning(pidFromFile)) {
      throw new Error(
        `O PID ${pidFromFile} está ativo, mas a API autenticada não respondeu. Nenhum sinal foi enviado por segurança.`,
      );
    }
    await rm(config.pidPath, { force: true });
    console.log("Threadmark já está parado.");
    return;
  }
  if (daemon.state === "foreign" || daemon.state === "unavailable") {
    throw new Error(`${daemon.message} Nenhum processo foi encerrado.`);
  }
  if (!daemon.authenticated || !daemon.identity || !token) {
    throw new Error(
      `${daemon.message} Nenhum processo foi encerrado sem a credencial desta instalação.`,
    );
  }
  const pid = daemon.identity.pid;
  if (
    pidFromFile &&
    isProcessRunning(pidFromFile) &&
    pidFromFile !== pid
  ) {
    throw new Error(
      `A API autenticada usa o PID ${pid}, mas o arquivo local aponta para ${pidFromFile}. Nenhum processo foi encerrado.`,
    );
  }
  await requestDaemonShutdown(config.apiUrl, token, pid);
  await waitForDaemonStopped(config.apiUrl, pid);
  await rm(config.pidPath, { force: true });
  console.log("Suporte Off. Captura e serviços locais encerrados com segurança.");
}

async function status(): Promise<void> {
  const config = loadConfig();
  const state = await new RuntimeStateFile(config.runtimeStatePath).read();
  const pid = await readPid(config.pidPath);
  console.log(
    JSON.stringify(
      {
        ...state,
        processRunning: Boolean(pid && isProcessRunning(pid)),
        whatsappEnabled: config.whatsappEnabled,
        agentEnabled: config.agentEnabled,
        agentExecutor: config.agentExecutor,
        interface: config.webOrigin,
        api: config.apiUrl,
      },
      null,
      2,
    ),
  );
}

async function openWeb(): Promise<void> {
  const { webOrigin } = loadConfig();
  await openLocalInterface(webOrigin);
  console.log(`Interface aberta em ${webOrigin}`);
}

async function configure(): Promise<void> {
  const requested = process.argv[3]?.toLowerCase();
  const section = requested
    ? parseConfigurationSection(requested)
    : await chooseConfigurationSection();
  const config = loadConfig();
  const url = configurationUrl(config.webOrigin, section);
  await openLocalInterface(url);
  console.log(`Configuração “${configurationSectionLabel(section)}” aberta em ${url}`);
}

async function chooseConfigurationSection(): Promise<ConfigurationSection> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return "general";
  console.log("\nConfigurar Threadmark\n");
  const choices: Array<{ key: string; section: ConfigurationSection; label: string }> = [
    { key: "1", section: "general", label: "Workspace e preferências" },
    { key: "2", section: "whatsapp", label: "WhatsApp e QR Code" },
    { key: "3", section: "staff", label: "Equipe WhatsApp" },
    { key: "4", section: "data", label: "Dados e backups" },
  ];
  for (const choice of choices) console.log(`  ${choice.key}. ${choice.label}`);
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await prompt.question("\nSelecione uma seção [1]: ")).trim() || "1";
    const selected = choices.find((choice) => choice.key === answer);
    if (!selected) throw new Error("Seleção inválida.");
    return selected.section;
  } finally {
    prompt.close();
  }
}

function parseConfigurationSection(value: string): ConfigurationSection {
  if (["ai", "ia", "tools", "tool", "ferramentas"].includes(value)) {
    throw new Error(
      "Modelos, skills e ferramentas agora são configurados no ambiente do agente (por exemplo, Hermes).",
    );
  }
  const aliases: Record<string, ConfigurationSection> = {
    general: "general",
    geral: "general",
    whatsapp: "whatsapp",
    team: "staff",
    staff: "staff",
    equipe: "staff",
    data: "data",
    dados: "data",
    backup: "data",
  };
  const section = aliases[value];
  if (!section) {
    throw new Error(
      "Seção inválida. Use general, whatsapp, team ou data.",
    );
  }
  return section;
}

function configurationSectionLabel(section: ConfigurationSection): string {
  return {
    general: "Geral",
    ai: "IA",
    tools: "Ferramentas",
    whatsapp: "WhatsApp",
    staff: "Equipe WhatsApp",
    data: "Dados",
  }[section];
}

async function toolsCommand(): Promise<void> {
  const action = (process.argv[3] ?? "open").toLowerCase();
  if (action === "open" || action === "add") {
    console.log(
      "As ferramentas do agente são configuradas no Hermes. " +
        "O Threadmark mantém este comando apenas para consultar ou desativar registros legados.",
    );
    return;
  }

  const config = loadConfig();
  const token = await new LocalAccessToken(config.localAccessTokenPath).ensure();
  if (action === "discover" || action === "recover") {
    const payload = await machineApi<{ items: Array<{
      id: string;
      name: string;
      type: string;
      rootPath: string;
      status: "ready" | "already_imported" | "unavailable";
      statusMessage: string;
    }> }>(config.apiUrl, token, "/api/tools/legacy-candidates");
    console.table(
      payload.items.map((candidate) => ({
        id: candidate.id,
        nome: candidate.name,
        tipo: candidate.type,
        caminho: candidate.rootPath,
        estado: candidate.status,
      })),
    );
    if (!payload.items.length) {
      console.log("Nenhuma configuração antiga de ferramentas foi encontrada.");
      return;
    }
    if (action === "discover") return;

    const readyIds = payload.items
      .filter((candidate) => candidate.status === "ready")
      .map((candidate) => candidate.id);
    if (!readyIds.length) {
      console.log("Todas as configurações encontradas já foram importadas ou estão indisponíveis.");
      return;
    }
    await confirmLegacyToolRecovery(readyIds.length);
    const result = await machineApi<{
      importedCount: number;
      alreadyImportedCount: number;
    }>(config.apiUrl, token, "/api/tools/legacy-import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ candidateIds: readyIds }),
    });
    console.log(
      `${result.importedCount} ferramenta(s) importada(s); ` +
        `${result.alreadyImportedCount} já estava(m) configurada(s).`,
    );
    return;
  }
  if (action === "list") {
    const payload = await machineApi<{ items: Array<{
      id: string;
      name: string;
      type: string;
      enabled: boolean;
      lastTestStatus?: string | null;
    }> }>(config.apiUrl, token, "/api/tools");
    console.table(
      payload.items.map((tool) => ({
        id: tool.id,
        nome: tool.name,
        tipo: tool.type,
        ativa: tool.enabled ? "sim" : "não",
        último_teste: tool.lastTestStatus ?? "—",
      })),
    );
    if (!payload.items.length) console.log("Nenhuma ferramenta configurada.");
    return;
  }

  const toolId = process.argv[4]?.trim();
  if (!toolId) throw new Error(`Informe o ID: threadmark tools ${action} <id>`);
  if (action === "test") {
    const result = await machineApi<{ ok: boolean; message: string }>(
      config.apiUrl,
      token,
      `/api/tools/${encodeURIComponent(toolId)}/test`,
      { method: "POST" },
    );
    console.log(`${result.ok ? "✓" : "!"} ${result.message}`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (action === "disable") {
    await machineApi(
      config.apiUrl,
      token,
      `/api/tools/${encodeURIComponent(toolId)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      },
    );
    console.log(`Ferramenta ${toolId} desativada.`);
    return;
  }
  throw new Error(
    "Use: threadmark tools list|discover|recover [--yes]|test <id>|disable <id>.",
  );
}

async function confirmLegacyToolRecovery(count: number): Promise<void> {
  if (process.argv.includes("--yes")) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("A recuperação exige confirmação interativa ou a opção --yes.");
  }
  console.log(`\n${count} configuração(ões) antiga(s) será(ão) autorizada(s) em modo readonly.`);
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question("Digite IMPORTAR para continuar: ");
    if (answer.trim() !== "IMPORTAR") throw new Error("Importação cancelada.");
  } finally {
    prompt.close();
  }
}

async function machineApi<T = unknown>(
  apiUrl: string,
  token: string,
  route: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  let response: Response;
  try {
    response = await fetch(new URL(route, apiUrl), { ...init, headers });
  } catch {
    throw new Error("A API local está indisponível. Execute `threadmark on` primeiro.");
  }
  const payload = (await response.json().catch(() => null)) as
    | T
    | { error?: { message?: string }; message?: string }
    | null;
  if (!response.ok) {
    const objectPayload =
      payload && typeof payload === "object"
        ? (payload as { error?: { message?: string }; message?: string })
        : null;
    const message = objectPayload?.error?.message ?? objectPayload?.message;
    throw new Error(message || `A API respondeu HTTP ${response.status}.`);
  }
  return payload as T;
}

async function doctor(): Promise<void> {
  const config = loadConfig();
  let database: Database.Database | null = null;
  let aiSettings: AiProviderSettingsService | null = null;
  if (config.agentExecutor === "internal" && existsSync(config.databasePath)) {
    try {
      database = new Database(config.databasePath, {
        readonly: true,
        fileMustExist: true,
      });
      database.pragma("query_only = ON");
      aiSettings = new AiProviderSettingsService(
        database,
        new LocalSecretVault(path.join(config.dataDir, "secrets")),
        { codexBin: config.codexBin, attachmentsRoot: config.attachmentsDir },
      );
    } catch {
      database?.close();
      database = null;
      aiSettings = null;
    }
  }
  const report = await runDoctor(config, { aiSettings });
  database?.close();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log("\nThreadmark Doctor\n");
    for (const probe of report.probes) {
      console.log(
        `${doctorSymbol(probe.state)} ${probe.label.padEnd(20)} ${probe.message}`,
      );
    }
    console.log(
      `\n${report.failures} falha(s), ${report.warnings} aviso(s), verificado em ${report.checkedAt}.`,
    );
  }
  if (!report.healthy) process.exitCode = 1;
}

function doctorSymbol(state: DoctorProbeState): string {
  return { ok: "✓", warning: "!", failed: "✗", skipped: "–" }[state];
}

async function serviceCommand(): Promise<void> {
  const action = (process.argv[3] ?? "status").toLowerCase();
  if (action === "install") {
    const config = loadConfig();
    const runningPid = await readPid(config.pidPath);
    if (runningPid && isProcessRunning(runningPid)) {
      console.log("Migrando o processo atual para o serviço automático…");
      await stop();
    }
    const result = await installLaunchAgent(config);
    console.log(
      `Serviço automático instalado e iniciado. Arquivo: ${result.plistPath}`,
    );
    return;
  }
  if (action === "uninstall") {
    const result = await uninstallLaunchAgent();
    console.log(
      `Serviço automático removido. Os dados locais foram preservados em ${loadConfig().dataDir}.`,
    );
    if (result.loaded) process.exitCode = 1;
    return;
  }
  if (action === "status") {
    const result = await getLaunchAgentStatus();
    console.log(
      JSON.stringify(
        {
          supported: result.supported,
          installed: result.installed,
          loaded: result.loaded,
          label: result.label,
          plistPath: result.plistPath,
        },
        null,
        2,
      ),
    );
    return;
  }
  throw new Error("Use: threadmark service install|uninstall|status.");
}

function listGroups(): void {
  const config = loadConfig();
  const database = createDatabase(config.databasePath);
  try {
    const groups = database
      .prepare(
        `SELECT g.subject, g.external_jid AS jid, g.monitored,
                COUNT(DISTINCT m.id) AS messages,
                MAX(m.occurred_at) AS last_message_at
         FROM whatsapp_groups g
         LEFT JOIN messages m ON m.group_id = g.id
         GROUP BY g.id
         ORDER BY g.monitored DESC, last_message_at DESC, g.subject`,
      )
      .all() as Array<{
      subject: string;
      jid: string;
      monitored: number;
      messages: number;
      last_message_at: string | null;
    }>;
    console.table(
      groups.map((group) => ({
        cliente_grupo: group.subject,
        jid: group.jid,
        monitorado: group.monitored ? "sim" : "não",
        mensagens: group.messages,
        ultima_mensagem: group.last_message_at ?? "—",
      })),
    );
    if (!groups.length) {
      console.log("Nenhum grupo descoberto. Inicie o suporte e conclua a sincronização inicial.");
    }
  } finally {
    database.close();
  }
}

async function setMonitored(enabled: boolean): Promise<void> {
  const jids = process.argv.slice(3).filter((argument) => !argument.startsWith("--"));
  if (!jids.length || jids.some((jid) => !jid.endsWith("@g.us"))) {
    throw new Error(`Informe um ou mais JIDs de grupo: npm run support -- ${enabled ? "monitor" : "unmonitor"} 120...@g.us`);
  }
  const config = loadConfig();
  const settingsFile = new LocalSettingsFile(config.localSettingsPath);
  const settings = await settingsFile.read();
  const next = new Set(settings.monitoredGroupJids);
  for (const jid of jids) {
    if (enabled) next.add(jid);
    else next.delete(jid);
  }
  await settingsFile.write({ ...settings, monitoredGroupJids: [...next] });

  const database = createDatabase(config.databasePath);
  try {
    const changes = updateConversationMonitoring(database, jids, enabled);
    console.log(`${changes} grupo(s) ${enabled ? "marcado(s) para monitoramento" : "removido(s) do monitoramento"}.`);
    if (enabled) {
      console.log("Reinicie o Suporte para aplicar a captura. `threadmark rescan --days=30` mostra somente quantas mensagens históricas seriam elegíveis, sem alterar a fila nem chamar a IA.");
    }
  } finally {
    database.close();
  }
}

function rescanHistory(): void {
  const input = parseHistoryRescanPreviewArguments(process.argv.slice(3));
  const config = loadConfig();
  const database = createDatabase(config.databasePath);
  try {
    const preview = previewHistoryRescan(database, input);
    const scope = input.requestedJids.length
      ? `${input.requestedJids.length} conversa(s) informada(s)`
      : "conversas monitoradas";
    console.log(
      `Prévia do histórico: ${preview.messages} mensagem(ns) em ${preview.conversations} conversa(s), nos últimos ${preview.days} dias (${scope}).`,
    );
    if (preview.oldestAt && preview.newestAt) {
      console.log(`Intervalo elegível: ${preview.oldestAt} até ${preview.newestAt}.`);
    }
    console.log("0 mensagens alteradas. 0 chamadas de IA. 0 sugestões criadas.");
    console.log(
      "A execução em massa permanece desabilitada até existir uma revisão histórica limitada, confirmável e reversível.",
    );
  } finally {
    database.close();
  }
}

async function updateStaff(add: boolean): Promise<void> {
  const identities = process.argv.slice(3).filter((argument) => !argument.startsWith("--"));
  if (!identities.length) {
    throw new Error(`Informe telefone, JID ou LID: npm run support -- staff:${add ? "add" : "remove"} 5511...`);
  }
  const config = loadConfig();
  const settingsFile = new LocalSettingsFile(config.localSettingsPath);
  const settings = await settingsFile.read();
  const next = new Set(
    settings.staffIdentitiesConfigured
      ? settings.staffIdentities
      : mergeConfiguredIdentities(config.staffIdentities, settings.staffIdentities),
  );
  for (const identity of identities) {
    if (add) next.add(identity);
    else next.delete(identity);
  }
  await settingsFile.write({
    ...settings,
    staffIdentities: [...next],
    staffIdentitiesConfigured: true,
    staffRestartRequired: true,
  });
  console.log(`Lista local de funcionários atualizada. Reinicie o Suporte para aplicar.`);
}

async function listStaff(): Promise<void> {
  const config = loadConfig();
  const settings = await new LocalSettingsFile(config.localSettingsPath).read();
  const combined = settings.staffIdentitiesConfigured
    ? settings.staffIdentities
    : [...new Set([...config.staffIdentities, ...settings.staffIdentities])];
  console.table(combined.map((identity) => ({ identidade: identity })));
  if (!combined.length) console.log("Nenhum funcionário adicional configurado; mensagens fromMe continuam sendo tratadas como staff.");
}

async function runOneInvestigation(): Promise<void> {
  const config = loadConfig();
  const database = createDatabase(config.databasePath);
  const store = new SupportStore(database);
  const secretVault = new LocalSecretVault(path.join(config.dataDir, "secrets"));
  const codexAgent = new CodexSupportAgent({
    codexBin: config.codexBin,
    cwd: config.projectRoot,
    dataDir: path.join(config.dataDir, "agent-runs"),
    attachmentsRoot: config.attachmentsDir,
    mcpToolLoopEnabled: config.codexMcpToolLoopEnabled,
    databasePath: config.databasePath,
    supportDataDir: config.dataDir,
  });
  const agent = new ConfiguredSupportAgent(
    database,
    new AiProviderSettingsService(
      database,
      secretVault,
      { codexBin: config.codexBin, attachmentsRoot: config.attachmentsDir },
    ),
    codexAgent,
    new DeepToolExecutor(new LocalToolService(database, secretVault), {
      database,
    }),
  );
  try {
    const processed = await new InvestigationWorker(store, agent, {
      recoverOrphanedJobs: false,
    }).runOne();
    console.log(processed ? "Uma investigação foi concluída." : "Não há investigação pendente.");
  } finally {
    database.close();
  }
}

async function backup(): Promise<void> {
  const action = process.argv[3]?.toLowerCase();
  if (action === "validate") {
    const target = process.argv[4]?.trim();
    if (!target) throw new Error("Use: threadmark backup validate <id-ou-diretório>.");
    const directory = await resolveBackupDirectory(target);
    const manifest = await validateLocalBackup({ directory });
    console.log(
      `Backup ${manifest.id} válido: ${manifest.mode}, ${manifest.files.length} arquivo(s), criado em ${manifest.createdAt}.`,
    );
    return;
  }
  if (action && !action.startsWith("--")) {
    throw new Error("Use: threadmark backup [--full] ou backup validate <id-ou-diretório>.");
  }
  const config = loadConfig();
  const database = createDatabase(config.databasePath);
  try {
    const mode = process.argv.includes("--full") || process.argv.includes("--with-attachments")
      ? "full"
      : "quick";
    const result = await createLocalBackup({
      database,
      backupsDirectory: config.backupsDir,
      settingsPath: config.localSettingsPath,
      attachmentsDirectory: config.attachmentsDir,
      mode,
      kind: "manual",
      label: "manual",
      retention: DEFAULT_LOCAL_BACKUP_RETENTION,
    });
    console.log(
      `Backup ${result.id} criado em ${result.directory} (${result.mode}${
        result.settingsIncluded ? ", configurações" : ""
      }${result.attachmentsIncluded ? ", anexos" : ""}).`,
    );
  } finally {
    database.close();
  }
}

async function listBackups(): Promise<void> {
  const action = (process.argv[3] ?? "list").toLowerCase();
  if (action !== "list") throw new Error("Use: threadmark backups list.");
  const backups = await listLocalBackups({
    backupsDirectory: loadConfig().backupsDir,
    verifyIntegrity: !process.argv.includes("--fast"),
  });
  console.table(
    backups.map((backup) => ({
      id: backup.id,
      criado_em: backup.createdAt ?? "—",
      modo: backup.mode ?? "—",
      tipo: backup.kind ?? "—",
      tamanho: formatFileSize(backup.size),
      válido: backup.valid ? "sim" : "não",
      erro: backup.error ?? "—",
    })),
  );
  if (!backups.length) console.log("Nenhum backup local encontrado.");
}

async function restoreBackup(): Promise<void> {
  const target = process.argv[3]?.trim();
  if (!target || target.startsWith("--")) {
    throw new Error("Use: threadmark restore <id-ou-diretório> [--yes].");
  }
  const config = loadConfig();
  const backupDirectory = await resolveBackupDirectory(target);
  const manifest = await validateLocalBackup({ directory: backupDirectory });
  await confirmRestore(manifest.id, backupDirectory);
  const result = await restoreLocalBackup({
    backupDirectory,
    databasePath: config.databasePath,
    settingsPath: config.localSettingsPath,
    attachmentsDirectory: config.attachmentsDir,
    backupsDirectory: config.backupsDir,
    pidPath: config.pidPath,
    retention: DEFAULT_LOCAL_BACKUP_RETENTION,
  });
  console.log(
    `Backup ${result.backupId} restaurado com sucesso. ` +
      `Estado anterior preservado em ${result.safetyBackup?.directory ?? "backup de segurança não necessário"}.`,
  );
  console.log("Execute `threadmark on` para iniciar o serviço com os dados restaurados.");
}

async function resolveBackupDirectory(target: string): Promise<string> {
  const config = loadConfig();
  if (path.isAbsolute(target) || target.includes(path.sep)) {
    return path.resolve(process.env.THREADMARK_INVOKE_CWD ?? process.cwd(), target);
  }
  const backups = await listLocalBackups({
    backupsDirectory: config.backupsDir,
    verifyIntegrity: false,
  });
  const match = backups.find((backup) => backup.id === target);
  if (!match) throw new Error(`Backup ${target} não encontrado em ${config.backupsDir}.`);
  return match.directory;
}

async function confirmRestore(backupId: string, directory: string): Promise<void> {
  if (process.argv.includes("--yes")) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("A restauração exige confirmação interativa ou a opção --yes.");
  }
  console.log("\nA restauração exige o Threadmark parado.");
  console.log(`Origem: ${directory}`);
  console.log("O estado atual será salvo automaticamente em um backup de segurança.");
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(`Digite RESTAURAR ${backupId} para continuar: `);
    if (answer.trim() !== `RESTAURAR ${backupId}`) {
      throw new Error("Restauração cancelada.");
    }
  } finally {
    prompt.close();
  }
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GiB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${bytes} B`;
}

async function hardenSecurity(): Promise<void> {
  const config = loadConfig();
  const result = await hardenPrivateState(config.dataDir);
  console.log(
    `Permissões locais revisadas: ${result.directories} diretório(s), ` +
      `${result.files} arquivo(s), ${result.skippedSymlinks} link(s) ignorado(s).`,
  );
}

function issueSetupToken(): void {
  const config = loadConfig();
  const database = createDatabase(config.databasePath);
  try {
    if (!new LocalAuthService(database).getSetupStatus().required) {
      throw new Error("A configuração inicial já foi concluída.");
    }
    const challenge = new SetupChallengeService(database).issue();
    console.log("Código de configuração inicial (válido por 30 minutos):");
    console.log(challenge.token);
  } finally {
    database.close();
  }
}

async function fetchQr(
  apiUrl: string,
  localAccessToken: string,
): Promise<string | null> {
  try {
    const response = await fetch(`${apiUrl}/api/runtime/qr`, {
      headers: { Authorization: `Bearer ${localAccessToken}` },
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as RuntimeQrResponse;
    return payload.qr;
  } catch {
    return null;
  }
}

async function readPid(pidPath: string): Promise<number | null> {
  try {
    const pid = Number.parseInt(await readFile(pidPath, "utf8"), 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readLocalAccessToken(tokenPath: string): Promise<string | null> {
  try {
    const token = (await readFile(tokenPath, "utf8")).trim();
    return token.length >= 32 ? token : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function printVersion(): Promise<void> {
  const packageFile = path.join(loadConfig().projectRoot, "package.json");
  const metadata = JSON.parse(await readFile(packageFile, "utf8")) as {
    version?: string;
  };
  console.log(`threadmark ${metadata.version ?? "desconhecida"}`);
}

function printHelp(): void {
  console.log(`Threadmark — central de suporte local-first

Uso:
  threadmark <comando> [opções]

Operação:
  on | start                  Inicia captura, API, Web UI e workers
  off | stop                  Encerra os serviços com segurança
  status                      Exibe o estado operacional
  open                        Abre a Web UI local
  doctor [--json]             Verifica processo, API, Web, SQLite, WhatsApp e disco

Configuração:
  configure [seção]           Abre o assistente (general, whatsapp, team, data)
  tools list                  Lista ferramentas legadas do Threadmark
  tools discover|recover      Revisa e recupera configurações antigas
  tools test|disable <id>     Testa ou desativa uma ferramenta legada
  service install             Inicia no login e recupera falhas no macOS
  service uninstall           Remove o serviço, preservando os dados
  service status              Mostra o estado do LaunchAgent

Dados e suporte:
  capabilities [--json]       Descreve a API headless e seus limites de segurança
  agent triage-* [--json]     Entrega a fila automática a um executor Hermes
  operators list [--json]     Lista identidades autorizáveis para auditoria
  conversations ... [--json] Consulta conversas, mensagens e tickets vinculados
  triage ... [--json]         Revisa ou aplica decisões de triagem
  tickets ... [--json]        Consulta e opera tickets por contrato estável
  categories ... [--json]     Consulta e mantém a taxonomia
  clients list [--json]       Lista clientes do workspace
  dashboard show [--json]     Consulta métricas operacionais
  backup [--full]             Cria backup rápido ou completo com anexos
  backup validate <id|path>   Valida manifesto, checksums e SQLite
  backups list [--fast]       Lista backups locais
  restore <id|path> [--yes]   Restaura com backup de segurança e rollback
  groups                      Lista grupos descobertos
  monitor <jid...>            Monitora grupos
  unmonitor <jid...>          Remove grupos do monitoramento
  rescan [--days=30] [jid...] Mostra prévia segura do histórico (sem escrita/IA)
  staff:add <identidade...>   Adiciona integrantes da equipe
  staff:remove <identidade...> Remove integrantes da equipe
  staff:list                  Lista a equipe configurada
  agent:once                  Executa uma investigação pendente
  security:harden             Reaplica permissões privadas
  setup-token                 Emite o código de configuração inicial

  -h, --help                  Mostra esta ajuda
  -v, --version               Mostra a versão`);
}
