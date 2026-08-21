import { mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";

import { CodexSupportAgent } from "./agent/codex-runner.js";
import { InvestigationWorker } from "./agent/investigation-worker.js";
import { InvestigationExecutionRegistry } from "./agent/investigation-execution-registry.js";
import { ConfiguredSupportAgent } from "./agent/provider-router.js";
import { AiProviderSettingsService } from "./agent/provider-settings.js";
import { createDatabase } from "./db/index.js";
import { SupportStore } from "./domain/index.js";
import { createSqliteInboundSink } from "./ingestion/sqlite-sink.js";
import { ConnectedAppService } from "./integrations/index.js";
import { startApiServer } from "./index.js";
import { loadConfig } from "./runtime/config.js";
import { waitForDaemonReady } from "./runtime/daemon-control.js";
import { LocalSecretVault } from "./runtime/secret-vault.js";
import {
  LocalSettingsFile,
  mergeConfiguredIdentities,
} from "./runtime/local-settings.js";
import { readRuntimeCounts } from "./runtime/runtime-counts.js";
import { offlineRuntimeState, RuntimeStateFile } from "./runtime/runtime-state.js";
import { resolveConfiguredStaffIdentities } from "./runtime/staff-identities.js";
import {
  WebBuildReloadMonitor,
  webBuildReloadPath,
} from "./runtime/web-build-reload.js";
import { createVinextWebProcessController } from "./runtime/web-process.js";
import { waitForWebBuildReady } from "./runtime/web-readiness.js";
import { DeepToolExecutor } from "./tools/deep-tool-executor.js";
import { LocalToolService } from "./tools/local-tool-service.js";
import { NotificationService } from "./notifications/index.js";
import { TriageAiScheduler, TriageWorker } from "./triage/index.js";
import { AudioTranscriptionService } from "./transcription/index.js";
import { createInboundWhatsAppClient } from "./whatsapp/index.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const localSettings = await new LocalSettingsFile(config.localSettingsPath).read();
  const monitoredGroupJids = mergeConfiguredIdentities(
    config.monitoredGroupJids,
    localSettings.monitoredGroupJids,
  );
  const staffIdentities = localSettings.staffIdentitiesConfigured
    ? localSettings.staffIdentities
    : mergeConfiguredIdentities(
        config.staffIdentities,
        localSettings.staffIdentities,
      );
  await claimPidFile(config.pidPath);
  const runtimeState = new RuntimeStateFile(config.runtimeStatePath);
  const startedAt = new Date().toISOString();
  await runtimeState.write({
    ...offlineRuntimeState(),
    phase: "starting",
    pid: process.pid,
    startedAt,
    updatedAt: startedAt,
  });
  const shutdownRequest = createShutdownRequest();

  const database = createDatabase(config.databasePath);
  const store = new SupportStore(database);
  const secretVault = new LocalSecretVault(path.join(config.dataDir, "secrets"));
  const notifications = new NotificationService(database);
  const providerSettings = new AiProviderSettingsService(
    database,
    secretVault,
    { codexBin: config.codexBin, attachmentsRoot: config.attachmentsDir },
  );
  const initialTriageProfile = providerSettings
    .getProfiles()
    .find((profile) => profile.taskKind === "triage");
  const currentTriageSettings = store.getTriageAiSettings();
  const expectedTriageSettings = {
    enabled: initialTriageProfile?.enabled ?? config.triageAiEnabled,
    model: initialTriageProfile?.model ?? config.triageAiModel,
    silenceWindowSeconds:
      currentTriageSettings.updatedBy === "default"
        ? Math.round(config.triageAiQuietMs / 1_000)
        : currentTriageSettings.silenceWindowSeconds,
  };
  if (
    currentTriageSettings.enabled !== expectedTriageSettings.enabled ||
    currentTriageSettings.model !== expectedTriageSettings.model ||
    currentTriageSettings.silenceWindowSeconds !==
      expectedTriageSettings.silenceWindowSeconds
  ) {
    store.updateTriageAiSettings({
      ...expectedTriageSettings,
      actor: initialTriageProfile ? "ai-task-profile" : "environment",
    });
  }
  const resolvedStaff = resolveConfiguredStaffIdentities(store, staffIdentities);
  const staffReconciliation = store.reconcileStaffMembers(
    resolvedStaff.participantIds,
  );
  if (localSettings.staffRestartRequired) {
    await new LocalSettingsFile(config.localSettingsPath).write({
      ...localSettings,
      staffRestartRequired: false,
    });
  }
  if (staffReconciliation.activated || staffReconciliation.deactivated) {
    console.log(
      `Equipe local reconciliada: ${staffReconciliation.active} identidade(s) ativa(s), ` +
        `${staffReconciliation.deactivated} vínculo(s) antigo(s) desativado(s), ` +
        `${staffReconciliation.restoredMessages} mensagem(ns) restaurada(s) para revisão.`,
    );
  }
  const persistedCounts = readRuntimeCounts(database);
  await runtimeState.patch({
    messagesStored: persistedCounts.messagesStored,
    groupsDiscovered: persistedCounts.groupsDiscovered,
    groupsSynced: persistedCounts.groupsSynced,
    privateConversations: persistedCounts.privateConversations,
    ticketsCreated: persistedCounts.ticketsCreated,
  });
  const sink = createSqliteInboundSink({
    store,
    runtimeState,
    attachmentsDirectory: config.attachmentsDir,
    accountPhone: config.whatsappPhone,
    accountName: config.whatsappName,
  });
  const whatsapp = config.whatsappEnabled
    ? createInboundWhatsAppClient({
        authDirectory: config.authDir,
        sink,
        allowlistedGroupJids: monitoredGroupJids,
        staffIdentities: resolvedStaff.policyIdentities,
        media: { enabled: true, maxBytes: 20 * 1024 * 1024, timeoutMs: 30_000 },
      })
    : null;
  const investigationExecutions = new InvestigationExecutionRegistry();
  const audioTranscription = new AudioTranscriptionService(database, {
    modelsDirectory: path.join(config.dataDir, "models", "transcription"),
    onError: (error) => console.error("Falha na transcrição local", error),
  });
  const apiServer = startApiServer({
    host: config.apiHost,
    port: config.apiPort,
    store,
    database,
    runtimeState,
    qrReader: sink,
    investigationExecutions,
    audioTranscription,
    requestShutdown: shutdownRequest.request,
    whatsappQrController: whatsapp
      ? {
          async renewQr() {
            sink.clearEphemeralQr();
            await runtimeState.patch({
              phase: "starting",
              whatsappConnected: false,
              qrAvailable: false,
              lastError: null,
            });
            try {
              await whatsapp.renewQr();
            } catch (error) {
              await runtimeState.patch({
                phase: "error",
                whatsappConnected: false,
                qrAvailable: false,
                lastError: error instanceof Error ? error.message : String(error),
              });
              throw error;
            }
          },
        }
      : undefined,
    notifications,
  });
  const webProcess = config.startWeb
    ? createVinextWebProcessController(config.projectRoot)
    : null;
  const webReloadMonitor = webProcess
    ? new WebBuildReloadMonitor(
        webBuildReloadPath(config.dataDir),
        async () => {
          console.log("Novo build detectado; reiniciando somente a interface web.");
          await webProcess.restart();
          await waitForWebBuildReady(config.webOrigin);
          console.log("Interface web atualizada sem interromper WhatsApp ou API.");
        },
        {
          onError: (error) =>
            console.error("Falha ao atualizar a interface apos o build", error),
        },
      )
    : null;
  if (webReloadMonitor) {
    try {
      await webReloadMonitor.start();
    } catch (error) {
      console.error(
        "Monitor de build indisponivel; a interface continuara ativa sem reload automatico",
        error,
      );
    }
  }
  const controller = new AbortController();
  const backgroundTasks: Promise<void>[] = [];
  backgroundTasks.push(audioTranscription.run(controller.signal));

  if (config.agentEnabled) {
    const triageScheduler = new TriageAiScheduler(store, {
      onError: (error) => console.error("Falha ao preparar triagem", error),
    });
    backgroundTasks.push(triageScheduler.run(controller.signal));
    const codexAgent = new CodexSupportAgent({
      codexBin: config.codexBin,
      cwd: config.projectRoot,
      dataDir: path.join(config.dataDir, "agent-runs"),
      attachmentsRoot: config.attachmentsDir,
    });
    const deepTools = new DeepToolExecutor(
      new LocalToolService(database, secretVault),
      {
        database,
        connectedApps: new ConnectedAppService(database, secretVault),
        integrationVault: secretVault,
      },
    );
    const agent = new ConfiguredSupportAgent(
      database,
      providerSettings,
      codexAgent,
      deepTools,
    );
    const investigations = new InvestigationWorker(store, agent, {
      executionRegistry: investigationExecutions,
      onEvent(event) {
        if (event.type === "failed") {
          console.error(`Investigação ${event.jobId} falhou: ${event.error}`);
        }
        if (
          (event.type === "completed" || event.type === "failed") &&
          event.ticketId &&
          (event.jobKind === "automatic" || event.jobKind === "thread_turn")
        ) {
          void Promise.resolve().then(() => {
            const ticket = store.getTicketDetail(event.ticketId!);
            const investigation = event.jobKind === "thread_turn"
              ? "Investigação aprofundada"
              : "Investigação automática";
            return notifications.createForAll({
              title: event.type === "completed"
                ? `${investigation} concluída`
                : `${investigation} falhou`,
              body: `#${ticket.number} · ${ticket.client.name}\n${ticket.title}`,
              targetUrl: `/tickets/${ticket.number}`,
              sourceType: "investigation",
              sourceId: event.jobId,
              idempotencyKey: `investigation:${event.jobId}:${event.type}`,
              tone: event.type === "failed" ? "urgent" : "success",
            });
          }).catch((error) => {
            console.error(`Falha ao notificar conclusão da investigação ${event.jobId}`, error);
          });
        }
      },
    });
    backgroundTasks.push(investigations.run(controller.signal));
  } else {
    const triageWorker = new TriageWorker(store, {
      onError: (candidate, error) => {
        console.error(`Falha ao triar mensagem ${candidate.id}`, error);
      },
    });
    backgroundTasks.push(triageWorker.run(controller.signal));
  }

  let stopping = false;
  const stop = async (reason: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`Encerrando Threadmark (${reason})`);
    await runtimeState.patch({ phase: "stopping", qrAvailable: false });
    sink.clearEphemeralQr();
    controller.abort();
    await whatsapp?.stop().catch((error) => console.error("Falha ao parar WhatsApp", error));
    webReloadMonitor?.stop();
    await webProcess?.stop();
    await closeApi(apiServer);
    await Promise.allSettled(backgroundTasks);
    await audioTranscription.stop();
    database.close();
    await rm(config.pidPath, { force: true });
    await runtimeState.write(offlineRuntimeState());
  };

  let shutdownReason = "finalização";
  try {
    webProcess?.start();
    const readiness = await Promise.race([
      waitForDaemonReady({
        apiUrl: config.apiUrl,
        webOrigin: config.webOrigin,
        webEnabled: config.startWeb,
        timeoutMs: 30_000,
      }).then(() => null),
      shutdownRequest.promise,
    ]);
    if (readiness) {
      shutdownReason = readiness;
      return;
    }
    console.log(
      config.startWeb
        ? `API e interface web prontas em ${config.webOrigin}.`
        : `API local pronta em ${config.apiUrl}; interface web desativada.`,
    );
    if (whatsapp) {
      await whatsapp.start();
    } else {
      await runtimeState.patch({ phase: "offline", pid: process.pid, startedAt });
    }
    const interval = setInterval(() => {
      void runtimeState.patch({ pid: process.pid }).catch(console.error);
    }, 15_000);
    interval.unref();
    shutdownReason = await shutdownRequest.promise;
    clearInterval(interval);
  } catch (error) {
    await runtimeState.patch({
      phase: "error",
      lastError: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    shutdownRequest.dispose();
    await stop(shutdownReason);
  }
}

function createShutdownRequest(): {
  promise: Promise<string>;
  request: (reason: string) => void;
  dispose: () => void;
} {
  let settled = false;
  let resolvePromise!: (reason: string) => void;
  const promise = new Promise<string>((resolve) => {
    resolvePromise = resolve;
  });
  const request = (reason: string) => {
    if (settled) return;
    settled = true;
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    resolvePromise(reason);
  };
  const onInterrupt = () => request("SIGINT");
  const onTerminate = () => request("SIGTERM");
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  return {
    promise,
    request,
    dispose() {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
    },
  };
}

async function claimPidFile(pidPath: string): Promise<void> {
  await mkdir(path.dirname(pidPath), { recursive: true, mode: 0o700 });
  try {
    const previous = Number.parseInt(await readFile(pidPath, "utf8"), 10);
    if (Number.isSafeInteger(previous) && isProcessRunning(previous)) {
      throw new Error(`Threadmark já está rodando no PID ${previous}.`);
    }
    await rm(pidPath, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const handle = await open(pidPath, "wx", 0o600);
  await handle.writeFile(String(process.pid));
  await handle.close();
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function closeApi(server: ReturnType<typeof startApiServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

void main().catch(async (error) => {
  console.error(error);
  try {
    const config = loadConfig();
    await rm(config.pidPath, { force: true });
  } finally {
    process.exitCode = 1;
  }
});
