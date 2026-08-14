import { spawn } from "node:child_process";

import {
  CliRenderEvents,
  createCliRenderer,
  type CliRenderer,
  type KeyEvent,
} from "@opentui/core";

import type { RuntimeStatusDto } from "../shared/contracts.js";
import { loadConfig, type SupportConfig } from "../server/runtime/config.js";
import { LocalAccessToken } from "../server/auth/local-access-token.js";
import {
  RuntimeStateFile,
  type RuntimeState,
} from "../server/runtime/runtime-state.js";
import { SupportTuiApiClient } from "./api-client.js";
import {
  EMPTY_INVESTIGATIONS,
  createOfflineRuntime,
  filterTickets,
  nextFilter,
  type TuiState,
} from "./model.js";
import {
  renderSupportTui,
  selectedSuggestionBody,
  selectedTicketLabel,
} from "./view.js";

const REFRESH_INTERVAL_MS = 3_000;

class SupportTuiApplication {
  private readonly api: SupportTuiApiClient;
  private readonly runtimeFile: RuntimeStateFile;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshInFlight = false;
  private closed = false;

  private state: TuiState;

  constructor(
    private readonly renderer: CliRenderer,
    private readonly config: SupportConfig,
    initialRuntime: RuntimeStatusDto,
    localAccessToken: string,
  ) {
    this.api = new SupportTuiApiClient(config.apiUrl, localAccessToken);
    this.runtimeFile = new RuntimeStateFile(config.runtimeStatePath);
    this.state = {
      runtime: initialRuntime,
      dashboard: null,
      tickets: [],
      groups: [],
      investigations: EMPTY_INVESTIGATIONS,
      refreshedAt: null,
      apiOnline: false,
      error: null,
      selectedTicketId: null,
      selectedTicket: null,
      selectedIndex: 0,
      filter: "open",
      compactPane: "queue",
      overlay: null,
      loading: true,
      notice: null,
    };
  }

  start(): void {
    this.renderer.setTerminalTitle("Threadmark");
    this.renderer.keyInput.on("keypress", this.handleKeypress);
    this.renderer.on(CliRenderEvents.RESIZE, this.render);
    this.render();
    void this.refresh();
    this.refreshTimer = setInterval(
      () => void this.refresh(),
      REFRESH_INTERVAL_MS,
    );
  }

  private readonly handleKeypress = (key: KeyEvent): void => {
    const name = key.name.toLowerCase();
    const sequence = key.sequence;

    if ((key.ctrl && name === "c") || name === "q") {
      this.close();
      return;
    }
    if (sequence === "?" || name === "?") {
      this.state.overlay = this.state.overlay === "help" ? null : "help";
      this.render();
      return;
    }
    if (name === "escape") {
      if (this.state.overlay) this.state.overlay = null;
      else this.state.compactPane = "queue";
      this.render();
      return;
    }
    if (name === "g") {
      this.state.overlay =
        this.state.overlay === "operations" ? null : "operations";
      this.render();
      return;
    }
    if (this.state.overlay) return;

    if (name === "up" || name === "k") {
      this.moveSelection(-1);
      return;
    }
    if (name === "down" || name === "j") {
      this.moveSelection(1);
      return;
    }
    if (name === "return" || name === "enter" || name === "2") {
      this.state.compactPane = "detail";
      this.render();
      return;
    }
    if (name === "1") {
      this.state.compactPane = "queue";
      this.render();
      return;
    }
    if (name === "tab") {
      this.state.compactPane =
        this.state.compactPane === "queue" ? "detail" : "queue";
      this.render();
      return;
    }
    if (name === "f") {
      this.state.filter = nextFilter(this.state.filter);
      this.state.selectedIndex = 0;
      this.reconcileSelection();
      this.render();
      void this.loadSelectedTicket();
      return;
    }
    if (name === "r") {
      void this.refresh(true);
      return;
    }
    if (name === "i") {
      void this.queueInvestigation();
      return;
    }
    if (name === "c") {
      void this.copySuggestion();
      return;
    }
    if (name === "o") {
      this.openWebInterface();
    }
  };

  private readonly render = (): void => {
    if (this.closed) return;
    renderSupportTui(this.renderer, this.state);
  };

  private async refresh(manual = false): Promise<void> {
    if (this.refreshInFlight || this.closed) return;
    this.refreshInFlight = true;
    const showLoading = this.state.dashboard === null;
    if (showLoading) this.state.loading = true;
    if (manual) this.flash("Atualizando dados operacionais…", 1_200);
    if (showLoading) this.render();

    try {
      const snapshot = await this.api.getOperationsSnapshot();
      Object.assign(this.state, snapshot);
      this.reconcileSelection();
      await this.loadSelectedTicket();
    } catch (error) {
      this.state.apiOnline = false;
      this.state.error = error instanceof Error ? error.message : String(error);
      this.state.runtime = await this.readRuntimeFallback();
    } finally {
      this.state.loading = false;
      this.refreshInFlight = false;
      this.render();
    }
  }

  private reconcileSelection(): void {
    const tickets = filterTickets(this.state.tickets, this.state.filter);
    if (!tickets.length) {
      this.state.selectedIndex = 0;
      this.state.selectedTicketId = null;
      this.state.selectedTicket = null;
      return;
    }

    const currentIndex = this.state.selectedTicketId
      ? tickets.findIndex((ticket) => ticket.id === this.state.selectedTicketId)
      : -1;
    const nextIndex = currentIndex >= 0
      ? currentIndex
      : Math.max(0, Math.min(this.state.selectedIndex, tickets.length - 1));
    this.state.selectedIndex = nextIndex;
    const nextTicketId = tickets[nextIndex]?.id ?? null;
    this.state.selectedTicketId = nextTicketId;
    if (this.state.selectedTicket?.id !== nextTicketId) {
      this.state.selectedTicket = null;
    }
  }

  private moveSelection(delta: number): void {
    const tickets = filterTickets(this.state.tickets, this.state.filter);
    if (!tickets.length) return;
    this.state.selectedIndex = Math.max(
      0,
      Math.min(this.state.selectedIndex + delta, tickets.length - 1),
    );
    const nextTicketId = tickets[this.state.selectedIndex]?.id ?? null;
    this.state.selectedTicketId = nextTicketId;
    if (this.state.selectedTicket?.id !== nextTicketId) {
      this.state.selectedTicket = null;
    }
    this.render();
    void this.loadSelectedTicket();
  }

  private async loadSelectedTicket(): Promise<void> {
    const ticketId = this.state.selectedTicketId;
    if (!ticketId || !this.state.apiOnline) return;
    try {
      const ticket = await this.api.getTicket(ticketId);
      if (this.state.selectedTicketId !== ticketId || this.closed) return;
      this.state.selectedTicket = ticket;
      this.render();
    } catch (error) {
      if (this.state.selectedTicketId !== ticketId) return;
      this.state.error = error instanceof Error ? error.message : String(error);
      this.render();
    }
  }

  private async queueInvestigation(): Promise<void> {
    const ticketId = this.state.selectedTicketId;
    if (!ticketId) {
      this.flash("Selecione um ticket antes de investigar.");
      return;
    }
    if (!this.state.runtime.agentEnabled) {
      this.flash("O agente Codex está desativado neste modo.");
      return;
    }
    try {
      await this.api.queueInvestigation(ticketId);
      this.flash(`${selectedTicketLabel(this.state)} entrou na fila do Codex.`);
      await this.refresh();
    } catch (error) {
      this.flash(error instanceof Error ? error.message : String(error));
    }
  }

  private async copySuggestion(): Promise<void> {
    const suggestion = selectedSuggestionBody(this.state);
    if (!suggestion) {
      this.flash("Este ticket ainda não possui sugestão para copiar.");
      return;
    }
    if (this.renderer.copyToClipboardOSC52(suggestion)) {
      this.flash("Sugestão copiada para o clipboard.");
      return;
    }
    try {
      await copyWithPbcopy(suggestion);
      this.flash("Sugestão copiada para o clipboard.");
    } catch {
      this.flash("Não foi possível copiar a sugestão automaticamente.");
    }
  }

  private openWebInterface(): void {
    const child = spawn("open", [this.config.webOrigin], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    this.flash("Web UI aberta no navegador.");
  }

  private flash(message: string, duration = 3_500): void {
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.state.notice = message;
    this.render();
    this.noticeTimer = setTimeout(() => {
      this.state.notice = null;
      this.noticeTimer = null;
      this.render();
    }, duration);
  }

  private async readRuntimeFallback(): Promise<RuntimeStatusDto> {
    try {
      const state = await this.runtimeFile.read();
      return runtimeFromFile(state, this.config, this.state.runtime.monitoredGroups);
    } catch {
      return createOfflineRuntime(
        this.config.whatsappEnabled,
        this.config.agentEnabled,
      );
    }
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.renderer.keyInput.off("keypress", this.handleKeypress);
    this.renderer.off(CliRenderEvents.RESIZE, this.render);
    this.renderer.destroy();
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const runtimeFile = new RuntimeStateFile(config.runtimeStatePath);
  const fileState = await runtimeFile.read();
  const initialRuntime = runtimeFromFile(fileState, config, 0);
  const localAccessToken = await new LocalAccessToken(
    config.localAccessTokenPath,
  ).ensure();
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    clearOnShutdown: true,
    screenMode: "alternate-screen",
    backgroundColor: "#090B10",
    targetFps: 30,
    useMouse: false,
  });
  const application = new SupportTuiApplication(
    renderer,
    config,
    initialRuntime,
    localAccessToken,
  );
  application.start();
}

function runtimeFromFile(
  state: RuntimeState,
  config: SupportConfig,
  monitoredGroups: number,
): RuntimeStatusDto {
  return {
    state: state.phase,
    pid: state.pid,
    startedAt: state.startedAt,
    lastHeartbeatAt: state.updatedAt,
    lastSyncAt: null,
    connectedAccount: null,
    whatsappConnected: state.whatsappConnected,
    qrAvailable: state.qrAvailable,
    groupsDiscovered: state.groupsDiscovered,
    groupsSynced: state.groupsSynced,
    privateConversations: state.privateConversations,
    messagesStored: state.messagesStored,
    ticketsCreated: state.ticketsCreated,
    monitoredGroups,
    lastError: state.lastError,
    whatsappEnabled: config.whatsappEnabled,
    agentEnabled: config.agentEnabled,
  };
}

function copyWithPbcopy(content: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pbcopy encerrou com código ${code ?? "desconhecido"}`));
    });
    child.stdin.end(content);
  });
}

await main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Não foi possível abrir a TUI do Threadmark: ${message}`);
  process.exitCode = 1;
});
