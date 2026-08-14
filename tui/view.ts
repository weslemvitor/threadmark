import {
  BoxRenderable,
  TextAttributes,
  TextRenderable,
  type BoxOptions,
  type CliRenderer,
  type RenderContext,
  type TextOptions,
} from "@opentui/core";

import type {
  InvestigationJobState,
  RuntimeStatusDto,
  TicketDetailDto,
  TicketPriority,
  TicketSummaryDto,
} from "../shared/contracts.js";
import {
  FILTER_LABELS,
  STATUS_LABELS,
  filterTickets,
  formatRelativeTime,
  getLayoutMode,
  getOperationalNextAction,
  getOperationalSuggestion,
  investigationCount,
  truncateText,
  visibleTicketWindow,
  type LayoutMode,
  type TuiState,
} from "./model.js";

const COLOR = {
  background: "#090B10",
  panel: "#10131B",
  panelRaised: "#161A25",
  selected: "#2B2148",
  border: "#303648",
  borderStrong: "#6753D9",
  text: "#F4F5F8",
  muted: "#8992A5",
  dim: "#626B7D",
  purple: "#9B87F5",
  cyan: "#52D6E8",
  green: "#4ADEA4",
  yellow: "#F4C66A",
  red: "#FB7185",
  white: "#FFFFFF",
} as const;

interface RuntimePresentation {
  symbol: string;
  label: string;
  color: string;
}

export function renderSupportTui(
  renderer: CliRenderer,
  state: TuiState,
): void {
  for (const child of [...renderer.root.getChildren()]) {
    child.destroyRecursively();
  }

  const mode = getLayoutMode(renderer.width);
  const root = new BoxRenderable(renderer, {
    id: "threadmark-root",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: COLOR.background,
    padding: 1,
    rowGap: 1,
  });

  root.add(buildHeader(renderer, state, mode));
  root.add(buildMetrics(renderer, state, mode));

  if (renderer.height < 16) {
    root.add(buildSmallTerminalNotice(renderer, state));
  } else {
    root.add(buildMain(renderer, state, mode));
  }

  root.add(buildFooter(renderer, state, mode));
  renderer.root.add(root);
  renderer.requestRender();
}

function buildHeader(
  ctx: RenderContext,
  state: TuiState,
  mode: LayoutMode,
): BoxRenderable {
  const runtime = presentRuntime(state.runtime);
  const header = panel(ctx, {
    height: 3,
    flexDirection: "row",
    alignItems: "center",
    paddingX: 1,
    borderColor: state.apiOnline ? COLOR.borderStrong : COLOR.border,
  });
  header.add(
    text(ctx, mode === "compact" ? "TM  THREADMARK" : "THREADMARK  /  CENTRAL LOCAL", {
      height: 1,
      flexGrow: 1,
      minWidth: 0,
      flexShrink: 1,
      fg: COLOR.text,
      attributes: TextAttributes.BOLD,
      truncate: true,
    }),
  );
  const runtimeLabel = `${runtime.symbol} ${runtime.label}`;
  header.add(
    text(ctx, runtimeLabel, {
      height: 1,
      width: Math.min(mode === "compact" ? 16 : 24, runtimeLabel.length + 2),
      flexShrink: 0,
      fg: runtime.color,
      attributes: TextAttributes.BOLD,
      truncate: true,
    }),
  );
  return header;
}

function buildMetrics(
  ctx: RenderContext,
  state: TuiState,
  mode: LayoutMode,
): BoxRenderable {
  const totals = state.dashboard?.totals;
  const activeJobs =
    investigationCount(state.investigations, "queued") +
    investigationCount(state.investigations, "running");

  if (mode !== "wide") {
    const compact = panel(ctx, {
      height: 3,
      flexDirection: "row",
      alignItems: "center",
      paddingX: 1,
    });
    compact.add(
      text(
        ctx,
        `ABERTOS ${totals?.open ?? 0}  ·  REVISÃO ${totals?.needsReview ?? 0}  ·  IA ${activeJobs}  ·  GRUPOS ${state.runtime.monitoredGroups}  ·  ÓRFÃS ${totals?.orphanDemands ?? 0}`,
        {
          height: 1,
          flexGrow: 1,
          fg: COLOR.muted,
          truncate: true,
        },
      ),
    );
    return compact;
  }

  const strip = new BoxRenderable(ctx, {
    height: 5,
    width: "100%",
    flexDirection: "row",
    columnGap: 1,
    backgroundColor: COLOR.background,
  });
  strip.add(metric(ctx, "ABERTOS", totals?.open ?? 0, COLOR.cyan));
  strip.add(metric(ctx, "EM REVISÃO", totals?.needsReview ?? 0, COLOR.yellow));
  strip.add(metric(ctx, "INVESTIGAÇÕES", activeJobs, COLOR.purple));
  strip.add(metric(ctx, "GRUPOS", state.runtime.monitoredGroups, COLOR.green));
  strip.add(metric(ctx, "ÓRFÃS", totals?.orphanDemands ?? 0, COLOR.red));
  return strip;
}

function buildMain(
  ctx: RenderContext,
  state: TuiState,
  mode: LayoutMode,
): BoxRenderable {
  const main = new BoxRenderable(ctx, {
    flexGrow: 1,
    minHeight: 1,
    width: "100%",
    flexDirection: mode === "compact" ? "column" : "row",
    columnGap: 1,
    backgroundColor: COLOR.background,
  });

  if (state.overlay === "help") {
    main.add(buildHelp(ctx));
    return main;
  }
  if (state.overlay === "operations") {
    main.add(buildOperations(ctx, state, true));
    return main;
  }

  if (mode === "wide") {
    main.add(buildQueue(ctx, state, mode, "38%"));
    main.add(buildTicketDetail(ctx, state, "38%"));
    main.add(buildOperations(ctx, state, false));
    return main;
  }

  if (mode === "medium") {
    main.add(buildQueue(ctx, state, mode, "42%"));
    main.add(buildTicketDetail(ctx, state, "auto"));
    return main;
  }

  main.add(
    state.compactPane === "detail"
      ? buildTicketDetail(ctx, state, "100%")
      : buildQueue(ctx, state, mode, "100%"),
  );
  return main;
}

function buildQueue(
  ctx: RenderContext,
  state: TuiState,
  mode: LayoutMode,
  width: number | "auto" | `${number}%`,
): BoxRenderable {
  const filtered = filterTickets(state.tickets, state.filter);
  const capacity = Math.max(
    1,
    Math.floor(((ctx.height || 24) - (mode === "wide" ? 20 : 18)) / 3),
  );
  const window = visibleTicketWindow(filtered, state.selectedIndex, capacity);
  const queue = panel(ctx, {
    id: "ticket-queue",
    title: ` INBOX · ${FILTER_LABELS[state.filter]} · ${filtered.length} `,
    titleColor: COLOR.purple,
    width,
    flexShrink: 0,
    flexGrow: width === "auto" ? 1 : undefined,
    flexDirection: "column",
    paddingX: 1,
    paddingY: 1,
    overflow: "hidden",
  });

  if (!filtered.length) {
    const message = state.loading
      ? "Carregando fila operacional…"
      : state.apiOnline
        ? state.filter === "attention"
          ? "Nenhum ticket crítico neste filtro. Pressione f para ver os abertos."
          : "Nenhum ticket neste filtro. A captura continua ativa."
        : "A fila aparecerá quando a API local estiver disponível.";
    queue.add(
      text(ctx, message, {
        flexGrow: 1,
        fg: COLOR.muted,
        wrapMode: "word",
      }),
    );
    return queue;
  }

  window.items.forEach((ticket, localIndex) => {
    const absoluteIndex = window.start + localIndex;
    queue.add(
      buildTicketRow(
        ctx,
        ticket,
        absoluteIndex === state.selectedIndex,
        mode,
      ),
    );
  });
  return queue;
}

function buildTicketRow(
  ctx: RenderContext,
  ticket: TicketSummaryDto,
  selected: boolean,
  mode: LayoutMode,
): BoxRenderable {
  const marker = selected ? "▸" : prioritySymbol(ticket.priority);
  const review = ticket.needsReview ? " · REVISAR" : "";
  const row = new BoxRenderable(ctx, {
    height: 3,
    width: "100%",
    flexDirection: "column",
    backgroundColor: selected ? COLOR.selected : COLOR.panel,
    paddingX: 1,
    marginBottom: 0,
  });
  row.add(
    text(
      ctx,
      `${marker} #${ticket.number}  ${ticket.title}`,
      {
        height: 1,
        fg: selected ? COLOR.white : priorityColor(ticket.priority),
        attributes: selected ? TextAttributes.BOLD : TextAttributes.NONE,
        truncate: true,
      },
    ),
  );
  const store = ticket.affectedStore?.name
    ? ` · ${ticket.affectedStore.name}`
    : " · loja não identificada";
  const requester = requesterLabel(ticket.requester);
  const details = `${requester ?? "Solicitante não identificado"} · ${ticket.client.name}${store}${review} · ${formatRelativeTime(ticket.updatedAt)}`;
  row.add(
    text(ctx, details, {
      height: 1,
      fg: ticket.needsReview ? COLOR.yellow : COLOR.muted,
      truncate: true,
    }),
  );
  if (mode === "compact") row.height = 3;
  return row;
}

function buildTicketDetail(
  ctx: RenderContext,
  state: TuiState,
  width: number | "auto" | `${number}%`,
): BoxRenderable {
  const ticket = state.selectedTicket;
  const detail = panel(ctx, {
    id: "ticket-detail",
    title: ticket ? ` #${ticket.number} · ${STATUS_LABELS[ticket.status]} ` : " DETALHE ",
    titleColor: ticket ? statusColor(ticket.status) : COLOR.muted,
    width,
    flexGrow: width === "auto" ? 1 : undefined,
    minWidth: 0,
    flexDirection: "column",
    paddingX: 1,
    paddingY: 1,
    overflow: "hidden",
  });

  if (!ticket) {
    detail.add(
      text(
        ctx,
        state.loading
          ? "Carregando o contexto do ticket…"
          : "Selecione um ticket na Inbox para ver contexto, próxima ação e sugestão.",
        { flexGrow: 1, fg: COLOR.muted, wrapMode: "word" },
      ),
    );
    return detail;
  }

  if (ctx.height < 36) {
    return buildDenseTicketDetail(ctx, detail, ticket);
  }

  const nextAction = getOperationalNextAction(ticket);
  detail.add(
    text(ctx, ticket.title, {
      height: 2,
      fg: COLOR.text,
      attributes: TextAttributes.BOLD,
      wrapMode: "word",
      truncate: true,
    }),
  );
  const store = ticket.affectedStore
    ? `${ticket.affectedStore.name}${ticket.affectedStore.platform ? ` · ${ticket.affectedStore.platform}` : ""}`
    : "Ecommerce ainda não identificado";
  detail.add(
    text(ctx, `${ticket.client.name}  /  ${store}`, {
      height: 1,
      fg: ticket.affectedStore ? COLOR.cyan : COLOR.yellow,
      truncate: true,
    }),
  );
  detail.add(
    text(ctx, `SOLICITANTE  ${requesterLabel(ticket.requester) ?? "Ainda não identificado"}`, {
      height: 1,
      fg: ticket.requester ? COLOR.purple : COLOR.yellow,
      truncate: true,
    }),
  );
  const categories = ticket.categories.map((category) => category.label).join(" · ");
  detail.add(
    text(ctx, categories || "Sem categorias confirmadas", {
      height: 1,
      fg: COLOR.dim,
      truncate: true,
    }),
  );
  detail.add(
    detailSection(ctx, "RESUMO", ticket.summary, 4, COLOR.text),
  );
  detail.add(
    detailSection(
      ctx,
      "PRÓXIMA AÇÃO",
      nextAction ?? "Aguardando investigação ou revisão manual.",
      4,
      nextAction ? COLOR.cyan : COLOR.muted,
    ),
  );

  const suggestion = getOperationalSuggestion(ticket);
  if (suggestion) {
    detail.add(
      detailSection(
        ctx,
        `SUGESTÃO · ${Math.round(suggestion.confidence * 100)}%`,
        suggestion.body,
        6,
        COLOR.text,
      ),
    );
    if (suggestion.missingInformation.length) {
      detail.add(
        text(
          ctx,
          `Faltando: ${suggestion.missingInformation.join(" · ")}`,
          {
            height: 2,
            fg: COLOR.yellow,
            wrapMode: "word",
            truncate: true,
          },
        ),
      );
    }
  } else {
    detail.add(
      detailSection(
        ctx,
        "SUGESTÃO",
        "Nenhuma sugestão atual. Pressione i para enfileirar a investigação Codex.",
        4,
        COLOR.muted,
      ),
    );
  }
  return detail;
}

function buildDenseTicketDetail(
  ctx: RenderContext,
  detail: BoxRenderable,
  ticket: TicketDetailDto,
): BoxRenderable {
  detail.add(
    text(ctx, ticket.title, {
      height: 1,
      fg: COLOR.text,
      attributes: TextAttributes.BOLD,
      truncate: true,
    }),
  );
  const store = ticket.affectedStore?.name ?? "loja não identificada";
  detail.add(
    text(ctx, `${ticket.client.name} · ${store} · ${ticket.priority.toUpperCase()}`, {
      height: 1,
      fg: ticket.affectedStore ? COLOR.cyan : COLOR.yellow,
      truncate: true,
    }),
  );
  detail.add(
    text(ctx, `SOLICITANTE  ${requesterLabel(ticket.requester) ?? "Ainda não identificado"}`, {
      height: 1,
      fg: ticket.requester ? COLOR.purple : COLOR.yellow,
      truncate: true,
    }),
  );
  const nextAction = getOperationalNextAction(ticket);
  detail.add(
    text(ctx, `AÇÃO  ${nextAction ?? "Aguardando investigação ou revisão manual."}`, {
      height: ctx.height < 26 ? 1 : 2,
      fg: COLOR.cyan,
      wrapMode: "word",
      truncate: true,
    }),
  );
  const suggestion = getOperationalSuggestion(ticket);
  detail.add(
    text(
      ctx,
      suggestion
        ? `SUGESTÃO ${Math.round(suggestion.confidence * 100)}%  ${suggestion.body}`
        : "SUGESTÃO  Nenhuma sugestão atual. Pressione i para investigar.",
      {
        flexGrow: 1,
        minHeight: 1,
        fg: suggestion ? COLOR.text : COLOR.muted,
        wrapMode: "word",
        truncate: true,
      },
    ),
  );
  return detail;
}

function buildOperations(
  ctx: RenderContext,
  state: TuiState,
  expanded: boolean,
): BoxRenderable {
  const runtime = presentRuntime(state.runtime);
  const operations = panel(ctx, {
    id: "operations",
    title: " OPERAÇÃO ",
    titleColor: COLOR.green,
    flexGrow: 1,
    width: expanded ? "100%" : "auto",
    flexDirection: "column",
    paddingX: 1,
    paddingY: 1,
    overflow: "hidden",
  });

  if (ctx.height < 30) {
    const queued = investigationCount(state.investigations, "queued");
    const running = investigationCount(state.investigations, "running");
    const failed = investigationCount(state.investigations, "failed");
    operations.add(
      text(
        ctx,
        [
          `${runtime.symbol} ${runtime.label}`,
          `IA  ${running} executando · ${queued} fila · ${failed} falhas`,
          `GRUPOS  ${state.groups.filter((group) => group.monitored).length}/${state.groups.length}`,
          `SYNC  ${formatRelativeTime(state.runtime.lastSyncAt ?? state.runtime.lastHeartbeatAt)}`,
        ].join("\n"),
        { flexGrow: 1, fg: runtime.color, wrapMode: "word", truncate: true },
      ),
    );
    return operations;
  }

  operations.add(
    detailSection(
      ctx,
      "SERVIÇO",
      [
        `${runtime.symbol} ${runtime.label}`,
        `WhatsApp: ${state.runtime.whatsappEnabled ? (state.runtime.whatsappConnected ? "conectado" : "desconectado") : "desativado"}`,
        `Codex: ${state.runtime.agentEnabled ? "ativo" : "desativado"}`,
        `Sync: ${formatRelativeTime(state.runtime.lastSyncAt ?? state.runtime.lastHeartbeatAt)}`,
      ].join("\n"),
      expanded ? 6 : 5,
      runtime.color,
    ),
  );

  const queued = investigationCount(state.investigations, "queued");
  const running = investigationCount(state.investigations, "running");
  const failed = investigationCount(state.investigations, "failed");
  operations.add(
    detailSection(
      ctx,
      "INVESTIGAÇÕES",
      `◐ ${running} executando   ◇ ${queued} na fila   ! ${failed} falhas`,
      3,
      failed ? COLOR.red : running || queued ? COLOR.purple : COLOR.muted,
    ),
  );

  const activeJobs = state.investigations.items
    .filter((job) => job.state !== "completed")
    .slice(0, expanded ? 6 : 3);
  for (const job of activeJobs) {
    operations.add(
      text(
        ctx,
        `${jobSymbol(job.state)} #${job.ticketNumber} ${job.clientName} · ${jobStateLabel(job.state)}`,
        {
          height: 1,
          fg: jobColor(job.state),
          truncate: true,
        },
      ),
    );
  }

  const monitored = state.groups.filter((group) => group.monitored);
  operations.add(
    text(
      ctx,
      `\nGRUPOS  ${monitored.length} monitorados / ${state.groups.length} descobertos`,
      {
        height: 2,
        fg: COLOR.green,
        attributes: TextAttributes.BOLD,
        truncate: true,
      },
    ),
  );
  for (const group of monitored.slice(0, expanded ? 10 : 5)) {
    operations.add(
      text(
        ctx,
        `${group.openTicketCount ? "!" : "·"} ${group.subject} · ${group.openTicketCount} abertos · ${formatRelativeTime(group.lastMessageAt)}`,
        {
          height: 1,
          fg: group.openTicketCount ? COLOR.yellow : COLOR.muted,
          truncate: true,
        },
      ),
    );
  }

  if (!state.groups.length) {
    operations.add(
      text(ctx, "Nenhum grupo descoberto. Ligue o suporte para sincronizar.", {
        height: 2,
        fg: COLOR.muted,
        wrapMode: "word",
      }),
    );
  }
  return operations;
}

function buildHelp(ctx: RenderContext): BoxRenderable {
  const help = panel(ctx, {
    title: " AJUDA · ATALHOS ",
    titleColor: COLOR.purple,
    width: "100%",
    flexGrow: 1,
    flexDirection: "column",
    paddingX: 2,
    paddingY: 1,
  });
  help.add(
    text(
      ctx,
      [
        "NAVEGAÇÃO",
        "  ↑/↓ ou j/k     selecionar ticket",
        "  Enter ou 2     abrir detalhe no terminal compacto",
        "  1              voltar para a Inbox",
        "  f              alternar filtro da Inbox",
        "",
        "AÇÕES SEGURAS",
        "  i              enfileirar investigação Codex",
        "  c              copiar a sugestão para o clipboard",
        "  o              abrir a Web UI local",
        "  r              atualizar agora",
        "  g              abrir visão operacional de grupos e jobs",
        "",
        "SISTEMA",
        "  ?              abrir ou fechar esta ajuda",
        "  Esc            voltar ou fechar painel",
        "  q              sair somente da TUI (o suporte continua ligado)",
        "",
        "Esta interface não possui envio para WhatsApp.",
      ].join("\n"),
      {
        flexGrow: 1,
        fg: COLOR.text,
        wrapMode: "word",
      },
    ),
  );
  return help;
}

function buildSmallTerminalNotice(
  ctx: RenderContext,
  state: TuiState,
): BoxRenderable {
  const runtime = presentRuntime(state.runtime);
  const notice = panel(ctx, {
    title: " VISÃO COMPACTA ",
    titleColor: COLOR.yellow,
    flexGrow: 1,
    width: "100%",
    paddingX: 1,
    paddingY: 1,
  });
  notice.add(
    text(
      ctx,
      `${runtime.symbol} ${runtime.label}\n${state.dashboard?.totals.open ?? 0} tickets abertos · ${state.dashboard?.totals.needsReview ?? 0} em revisão\nAumente a altura do terminal para operar a fila.`,
      { flexGrow: 1, fg: COLOR.text, wrapMode: "word" },
    ),
  );
  return notice;
}

function buildFooter(
  ctx: RenderContext,
  state: TuiState,
  mode: LayoutMode,
): BoxRenderable {
  const footer = panel(ctx, {
    height: 3,
    flexDirection: "row",
    alignItems: "center",
    paddingX: 1,
  });
  const hint = mode === "compact"
    ? "↑↓ navegar  Enter detalhe  f filtro  i investigar  ? ajuda  q sair"
    : "↑↓ navegar  f filtro  i investigar  c copiar  g operação  o web  ? ajuda  q sair";
  const status = state.notice ?? state.error ?? hint;
  footer.add(
    text(ctx, status, {
      height: 1,
      flexGrow: 1,
      minWidth: 0,
      flexShrink: 1,
      fg: state.notice
        ? COLOR.green
        : state.error
          ? COLOR.red
          : COLOR.muted,
      truncate: true,
    }),
  );
  const freshness = state.loading
    ? "ATUALIZANDO"
    : state.refreshedAt
      ? `ATUALIZADO ${formatRelativeTime(state.refreshedAt)}`
      : "SEM DADOS";
  footer.add(
    text(ctx, freshness, {
      height: 1,
      width: Math.min(20, freshness.length + 1),
      flexShrink: 0,
      fg: state.apiOnline ? COLOR.green : COLOR.yellow,
      attributes: TextAttributes.BOLD,
      truncate: true,
    }),
  );
  return footer;
}

function metric(
  ctx: RenderContext,
  label: string,
  value: number,
  color: string,
): BoxRenderable {
  const card = panel(ctx, {
    height: 5,
    flexGrow: 1,
    flexDirection: "column",
    justifyContent: "center",
    paddingX: 1,
  });
  card.add(
    text(ctx, label, {
      height: 1,
      fg: COLOR.muted,
      truncate: true,
    }),
  );
  card.add(
    text(ctx, value.toLocaleString("pt-BR"), {
      height: 1,
      fg: color,
      attributes: TextAttributes.BOLD,
      truncate: true,
    }),
  );
  return card;
}

function detailSection(
  ctx: RenderContext,
  label: string,
  content: string,
  height: number,
  color: string,
): BoxRenderable {
  const section = new BoxRenderable(ctx, {
    height,
    width: "100%",
    flexDirection: "column",
    backgroundColor: COLOR.panelRaised,
    paddingX: 1,
    marginTop: 1,
    overflow: "hidden",
  });
  section.add(
    text(ctx, label, {
      height: 1,
      fg: COLOR.purple,
      attributes: TextAttributes.BOLD,
      truncate: true,
    }),
  );
  section.add(
    text(ctx, content, {
      flexGrow: 1,
      fg: color,
      wrapMode: "word",
      truncate: true,
    }),
  );
  return section;
}

function panel(ctx: RenderContext, options: BoxOptions = {}): BoxRenderable {
  return new BoxRenderable(ctx, {
    border: true,
    borderStyle: "rounded",
    borderColor: COLOR.border,
    backgroundColor: COLOR.panel,
    ...options,
  });
}

function text(
  ctx: RenderContext,
  content: string,
  options: TextOptions = {},
): TextRenderable {
  return new TextRenderable(ctx, {
    content,
    fg: COLOR.text,
    selectable: false,
    ...options,
  });
}

function requesterLabel(
  requester: { displayName: string; phoneE164: string | null } | null,
): string | null {
  if (!requester) return null;
  const phone = formatRequesterPhone(requester.phoneE164);
  const rawName = requester.displayName.trim();
  const nameDigits = rawName.replace(/\D/g, "");
  const phoneDigits = requester.phoneE164?.replace(/\D/g, "") ?? "";
  const nameIsPhone =
    Boolean(phoneDigits) &&
    Boolean(nameDigits) &&
    (phoneDigits.endsWith(nameDigits) || nameDigits.endsWith(phoneDigits));
  const name = rawName && !nameIsPhone ? rawName : phone ?? rawName;
  if (!name) return null;
  return phone && !nameIsPhone ? `${name} · ${phone}` : name;
}

function formatRequesterPhone(value: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  if (digits.length === 13 && digits.startsWith("55")) {
    return `+55 ${digits.slice(2, 4)} ${digits.slice(4, 9)}-${digits.slice(9)}`;
  }
  if (digits.length === 12 && digits.startsWith("55")) {
    return `+55 ${digits.slice(2, 4)} ${digits.slice(4, 8)}-${digits.slice(8)}`;
  }
  return value.trim() || null;
}

function presentRuntime(runtime: RuntimeStatusDto): RuntimePresentation {
  if (runtime.state === "error") {
    return { symbol: "!", label: "ERRO", color: COLOR.red };
  }
  if (!runtime.whatsappEnabled && runtime.pid) {
    return { symbol: "●", label: "LOCAL", color: COLOR.green };
  }
  if (runtime.state === "online") {
    return { symbol: "●", label: "ONLINE", color: COLOR.green };
  }
  if (runtime.state === "syncing") {
    return { symbol: "◐", label: "SINCRONIZANDO", color: COLOR.cyan };
  }
  if (runtime.state === "waiting_qr") {
    return { symbol: "◇", label: "AGUARDANDO QR", color: COLOR.yellow };
  }
  if (runtime.state === "starting") {
    return { symbol: "◐", label: "INICIANDO", color: COLOR.purple };
  }
  if (runtime.state === "stopping") {
    return { symbol: "◐", label: "ENCERRANDO", color: COLOR.yellow };
  }
  return { symbol: "○", label: "OFFLINE", color: COLOR.muted };
}

function prioritySymbol(priority: TicketPriority): string {
  if (priority === "urgent") return "!!";
  if (priority === "high") return "!";
  if (priority === "low") return "·";
  return "◇";
}

function priorityColor(priority: TicketPriority): string {
  if (priority === "urgent") return COLOR.red;
  if (priority === "high") return COLOR.yellow;
  if (priority === "low") return COLOR.dim;
  return COLOR.text;
}

function statusColor(status: TicketSummaryDto["status"]): string {
  if (status === "blocked") return COLOR.red;
  if (status === "resolved" || status === "archived") return COLOR.green;
  if (status === "waiting_customer") return COLOR.yellow;
  if (status === "in_progress") return COLOR.cyan;
  return COLOR.purple;
}

function jobSymbol(state: InvestigationJobState): string {
  if (state === "running") return "◐";
  if (state === "queued") return "◇";
  if (state === "failed") return "!";
  if (state === "cancelled") return "×";
  return "✓";
}

function jobStateLabel(state: InvestigationJobState): string {
  if (state === "running") return "executando";
  if (state === "queued") return "na fila";
  if (state === "failed") return "falhou";
  if (state === "cancelled") return "interrompida";
  return "concluída";
}

function jobColor(state: InvestigationJobState): string {
  if (state === "failed") return COLOR.red;
  if (state === "cancelled") return COLOR.yellow;
  if (state === "running") return COLOR.purple;
  if (state === "queued") return COLOR.yellow;
  return COLOR.green;
}

export function selectedSuggestionBody(state: TuiState): string | null {
  return state.selectedTicket
    ? getOperationalSuggestion(state.selectedTicket)?.body ?? null
    : null;
}

export function selectedTicketLabel(state: TuiState): string {
  const ticket = state.selectedTicket;
  if (!ticket) return "Nenhum ticket selecionado";
  return truncateText(`#${ticket.number} ${ticket.title}`, 80);
}
