"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, LoaderCircle } from "lucide-react";
import dynamic from "next/dynamic";
import {
  ApiError,
  addInvestigationThreadMessage,
  addTicketInternalNote,
  attachCategoryToTicket,
  createCategory,
  detachCategoryFromTicket,
  getCategories,
  bulkUpdateTicketStatus,
  cancelInvestigationThread,
  createManualTicket,
  deleteTicket,
  deleteTicketInternalNote,
  detachTicketMessage,
  getClients,
  getConversations,
  getDashboard,
  getDirectory,
  getInvestigationThread,
  getRuntime,
  getTicket,
  getTicketAssignees,
  getTickets,
  openInvestigationThread,
  upsertTicketProductForwarding,
  updateTicketInternalNote,
  updateTicketMetadata,
  updateTicketAssignee,
  updateTicketStatus,
} from "./lib/api";
import {
  disableBrowserNotifications,
  enableBrowserNotifications,
  getBrowserNotificationState,
  showBrowserNotification,
  type BrowserNotificationState,
} from "./lib/browser-notifications";
import {
  getInvestigationNotificationTitle,
  isFinishedInvestigationState,
} from "./lib/investigation-notifications";
import type {
  ClientSummary,
  DashboardData,
  CategoryFacetType,
  TicketCategoryCatalog,
  DirectorySnapshot,
  InvestigationThreadDto,
  RuntimeState,
  TicketDetail,
  TicketAssignee,
  TicketStatus,
  TicketSummary,
} from "./lib/types";
import {
  type UpsertTicketProductForwardingInput,
  type UpdateTicketMetadataInput,
} from "@/shared/contracts";
import { activeStatuses, configureSupportTimeZone } from "./lib/format";
import { isInvestigationActive } from "./lib/investigation";
import { isInvestigationTurnActive } from "./lib/investigation-thread";
import {
  handleSupportSearchShortcut,
  isSupportSearchShortcut,
} from "./lib/shortcuts";
import {
  TicketSnapshotCoordinator,
  type TicketSnapshot,
} from "./lib/ticket-snapshot-coordinator";
import {
  hasSameTicketPayload,
  ticketSummaryFromDetail,
} from "./lib/ticket-payload";
import {
  buildThreadmarkPath,
  parseThreadmarkLocation,
  type SettingsRouteTab,
  type ThreadmarkNavigation,
  type ViewId,
} from "./lib/navigation";
import { PageHeader, Sidebar } from "./components/layout";
import { ApiErrorBanner, SupportSearchOverlay } from "./components/shared";
import { useAppAccess } from "./features/access";
import type {
  ManualTicketDraft,
  ProductForwardingDraft,
} from "./features/tickets";
import type { SettingsTab } from "./features/settings";

function FeatureLoading({ label = "Carregando módulo…" }: { label?: string }) {
  return (
    <div className="flex min-h-56 items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
      <LoaderCircle className="animate-spin text-primary" size={18} />
      {label}
    </div>
  );
}

const DashboardView = dynamic(
  () => import("./features/dashboard").then((module) => module.DashboardView),
  {
    loading: () => <FeatureLoading label="Carregando indicadores…" />,
  },
);

const ConversationsView = dynamic(
  () => import("./features/conversations").then((module) => module.ConversationsView),
  { loading: () => <FeatureLoading label="Carregando conversas…" /> },
);
const TicketDetailPanel = dynamic(
  () => import("./features/tickets").then((module) => module.TicketDetail),
  { loading: () => <FeatureLoading label="Carregando atendimento…" /> },
);
const ManualTicketDialog = dynamic(
  () => import("./features/tickets").then((module) => module.ManualTicketDialog),
);
const InvestigationRoom = dynamic(
  () => import("./features/tickets").then((module) => module.InvestigationRoom),
);
const ProductForwardingDialog = dynamic(
  () => import("./features/tickets").then((module) => module.ProductForwardingDialog),
);
const TicketResolutionDialog = dynamic(
  () => import("./features/tickets").then((module) => module.TicketResolutionDialog),
);
const KanbanView = dynamic(
  () => import("./features/kanban").then((module) => module.KanbanView),
  { loading: () => <FeatureLoading label="Carregando Kanban…" /> },
);
const DirectoryView = dynamic(
  () => import("./features/directory").then((module) => module.DirectoryView),
  { loading: () => <FeatureLoading label="Carregando Diretório…" /> },
);
const CategoriesView = dynamic(
  () => import("./features/categories").then((module) => module.CategoriesView),
  { loading: () => <FeatureLoading label="Carregando categorias…" /> },
);
const SettingsView = dynamic(
  () => import("./features/settings").then((module) => module.SettingsView),
  { loading: () => <FeatureLoading label="Carregando configurações…" /> },
);

const pageContent: Record<ViewId, { title: string; subtitle: string }> = {
  conversations: {
    title: "Conversas",
    subtitle: "Histórico do WhatsApp e fila de triagem, sem envio de mensagens",
  },
  inbox: {
    title: "Tickets",
    subtitle: "Demandas criadas e acompanhadas até a resolução",
  },
  kanban: {
    title: "Kanban operacional",
    subtitle: "Acompanhe cada atendimento até a resolução",
  },
  clients: {
    title: "Diretório",
    subtitle: "Grupos e pessoas sincronizados do WhatsApp",
  },
  categories: {
    title: "Categorias de atendimento",
    subtitle: "Entenda motivos, produtos, sintomas e causas recorrentes",
  },
  dashboard: {
    title: "Visão do suporte",
    subtitle: "Volume, qualidade da triagem e demandas que exigem atenção",
  },
  settings: {
    title: "Configurações",
    subtitle: "Workspace, equipe, conexões e dados desta instalação",
  },
};

type ToastState = {
  tone: "success" | "warning";
  message: string;
} | null;

const ACTIVE_TICKET_POLL_INTERVAL_MS = 3_000;
const IDLE_TICKET_POLL_INTERVAL_MS = 5_000;
const MAX_TICKET_POLL_INTERVAL_MS = 30_000;
const TICKET_LIST_SNAPSHOT_KEY = "ticket-list";

export function SupportApp({
  initialPath = "/conversations",
}: {
  initialPath?: string;
}) {
  const access = useAppAccess();
  const initialNavigation = parseThreadmarkLocation(initialPath);
  const previousRoomTurnStateRef = useRef<InvestigationThreadDto["activeTurnState"]>(null);
  const [activeView, setActiveView] = useState<ViewId>(initialNavigation.view);
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab>(
    initialNavigation.settingsTab,
  );
  const [workspaceLabel, setWorkspaceLabel] = useState(
    access?.workspace.name ?? "Meu workspace",
  );
  const [workspaceTimeZone, setWorkspaceTimeZone] = useState(
    access?.workspace.timezone ?? "America/Sao_Paulo",
  );
  configureSupportTimeZone(workspaceTimeZone);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [tickets, setTickets] = useState<TicketSummary[]>([]);
  const [ticketAssignees, setTicketAssignees] = useState<TicketAssignee[]>([]);
  const [clients, setClients] = useState<ClientSummary[]>([]);
  const [categoryCatalog, setCategoryCatalog] = useState<TicketCategoryCatalog[]>([]);
  const [directorySnapshot, setDirectorySnapshot] =
    useState<DirectorySnapshot | null>(null);
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [runtime, setRuntime] = useState<RuntimeState | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [routeTicketReference, setRouteTicketReference] = useState<string | null>(
    initialNavigation.ticketReference,
  );
  const [ticketDetails, setTicketDetails] = useState<Map<string, TicketDetail>>(
    () => new Map(),
  );
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [updatingStatus, setUpdatingStatus] = useState(false);
  const [updatingTicketMetadata, setUpdatingTicketMetadata] = useState(false);
  const [assigningTicketId, setAssigningTicketId] = useState<string | null>(null);
  const [addingTicketNote, setAddingTicketNote] = useState(false);
  const [ticketNoteMutation, setTicketNoteMutation] = useState<{
    noteId: string;
    action: "edit" | "delete";
  } | null>(null);
  const [detachingTicketMessageId, setDetachingTicketMessageId] = useState<
    string | null
  >(null);
  const [categoryMutationTicketId, setCategoryMutationTicketId] = useState<
    string | null
  >(null);
  const [deletingTicketId, setDeletingTicketId] = useState<string | null>(null);
  const [manualTicketRequestId, setManualTicketRequestId] = useState<string | null>(null);
  const [creatingManualTicket, setCreatingManualTicket] = useState(false);
  const [manualTicketError, setManualTicketError] = useState<string | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState>(null);
  const [resolutionTarget, setResolutionTarget] = useState<string | null>(null);
  const [resolutionSummary, setResolutionSummary] = useState("");
  const [originalResolutionSummary, setOriginalResolutionSummary] = useState("");
  const [productForwardingTarget, setProductForwardingTarget] =
    useState<ProductForwardingDraft | null>(null);
  const [savingProductForwarding, setSavingProductForwarding] = useState(false);
  const [investigationRoomTarget, setInvestigationRoomTarget] = useState<string | null>(null);
  const [investigationThread, setInvestigationThread] =
    useState<InvestigationThreadDto | null>(null);
  const [investigationRoomLoading, setInvestigationRoomLoading] = useState(false);
  const [investigationRoomSending, setInvestigationRoomSending] = useState(false);
  const [investigationRoomStopping, setInvestigationRoomStopping] = useState(false);
  const [investigationRoomError, setInvestigationRoomError] = useState<string | null>(null);
  const [roomSearchOpen, setRoomSearchOpen] = useState(false);
  const [notificationState, setNotificationState] =
    useState<BrowserNotificationState>("unsupported");
  const [conversationRefreshVersion, setConversationRefreshVersion] = useState(0);
  const [pendingConversations, setPendingConversations] = useState(0);
  const ticketDetailsRef = useRef(ticketDetails);
  const ticketSnapshotCoordinatorRef = useRef(
    new TicketSnapshotCoordinator<TicketDetail>(),
  );
  const ticketListSnapshotCoordinatorRef = useRef(
    new TicketSnapshotCoordinator<TicketSummary[]>(),
  );
  const productForwardingReturnFocusRef = useRef<HTMLElement | null>(null);

  const applyLocationNavigation = useCallback(
    (navigation: ThreadmarkNavigation) => {
      setActiveView(navigation.view);
      setSettingsInitialTab(navigation.settingsTab);
      setSelectedId(null);
      setRouteTicketReference(navigation.ticketReference);
      setSidebarOpen(false);
    },
    [],
  );

  useEffect(() => {
    function readLocation() {
      const navigation = parseThreadmarkLocation(
        window.location.pathname,
        window.location.search,
      );
      applyLocationNavigation(navigation);
      if (navigation.legacy) {
        window.history.replaceState(
          {},
          "",
          buildThreadmarkPath(navigation),
        );
      }
    }

    readLocation();
    window.addEventListener("popstate", readLocation);
    return () => window.removeEventListener("popstate", readLocation);
  }, [applyLocationNavigation]);

  const routedSelectedId = useMemo(() => {
    if (activeView !== "inbox" || !routeTicketReference) return null;
    const normalizedReference = routeTicketReference.replace(/^#/, "");
    const ticket = tickets.find(
      (candidate) =>
        candidate.id === routeTicketReference ||
        String(candidate.number) === normalizedReference,
    );
    if (ticket) return ticket.id;
    return /^\d+$/.test(normalizedReference) ? null : routeTicketReference;
  }, [activeView, routeTicketReference, tickets]);

  const currentSelectedId = selectedId ?? routedSelectedId;
  const selectedTicket = currentSelectedId
    ? ticketDetails.get(currentSelectedId) ?? null
    : null;
  const investigationRoomTicket = investigationRoomTarget
    ? ticketDetails.get(investigationRoomTarget) ?? null
    : null;
  const reviewTickets = tickets.filter(
    (ticket) => ticket.needsReview || ticket.status === "triage",
  ).length;

  const showToast = useCallback((nextToast: NonNullable<ToastState>) => {
    setToast(nextToast);
    window.setTimeout(() => setToast(null), 3200);
  }, []);

  const navigateToView = useCallback(
    (
      view: ViewId,
      options?: {
        settingsTab?: SettingsRouteTab;
        replace?: boolean;
      },
    ) => {
      const nextSettingsTab = options?.settingsTab ?? "general";
      setActiveView(view);
      setSettingsInitialTab(nextSettingsTab);
      setSelectedId(null);
      setRouteTicketReference(null);
      setSidebarOpen(false);

      const path = buildThreadmarkPath({
        view,
        settingsTab: nextSettingsTab,
      });
      if (`${window.location.pathname}${window.location.search}` === path) return;
      window.history[options?.replace ? "replaceState" : "pushState"]({}, "", path);
    },
    [],
  );

  useEffect(() => {
    if (routeTicketReference) return;
    const selectedReference =
      selectedTicket?.number ??
      tickets.find((ticket) => ticket.id === currentSelectedId)?.number ??
      currentSelectedId;
    const path = buildThreadmarkPath({
      view: activeView,
      ticketReference: activeView === "inbox" ? selectedReference : null,
      settingsTab: settingsInitialTab,
    });
    if (`${window.location.pathname}${window.location.search}` !== path) {
      window.history.replaceState({}, "", path);
    }
  }, [
    activeView,
    routeTicketReference,
    currentSelectedId,
    selectedTicket?.number,
    settingsInitialTab,
    tickets,
  ]);

  const focusTicketSearch = useCallback(() => {
    setRoomSearchOpen(true);
  }, []);

  const requestTicketListSnapshot = useCallback(
    () =>
      ticketListSnapshotCoordinatorRef.current.request(
        TICKET_LIST_SNAPSHOT_KEY,
        () => getTickets(),
      ),
    [],
  );

  const commitTicketListSnapshot = useCallback(
    (
      snapshot: TicketSnapshot<TicketSummary[]>,
      reconcileSelection = false,
    ) => {
      if (
        !ticketListSnapshotCoordinatorRef.current.isCurrent(
          TICKET_LIST_SNAPSHOT_KEY,
          snapshot,
        )
      ) {
        return false;
      }
      setTickets(snapshot.detail);
      if (reconcileSelection) {
        setSelectedId((current) => {
          if (current && snapshot.detail.some((ticket) => ticket.id === current)) {
            return current;
          }
          return (
            snapshot.detail.find((ticket) => activeStatuses.includes(ticket.status))
              ?.id ??
            snapshot.detail[0]?.id ??
            null
          );
        });
      }
      return true;
    },
    [],
  );

  const loadData = useCallback(async () => {
    const [
      runtimeResult,
      dashboardResult,
      ticketsResult,
      clientsResult,
      directoryResult,
      categoriesResult,
      pendingConversationsResult,
      ticketAssigneesResult,
    ] =
      await Promise.allSettled([
        getRuntime(),
        getDashboard(),
        requestTicketListSnapshot(),
        getClients(),
        getDirectory(),
        getCategories(),
        getConversations({ attention: "pending", limit: 1 }),
        getTicketAssignees(),
      ]);

    const failures = [
      runtimeResult,
      dashboardResult,
      ticketsResult,
      clientsResult,
      directoryResult,
      categoriesResult,
      pendingConversationsResult,
      ticketAssigneesResult,
    ].filter((result) => result.status === "rejected") as PromiseRejectedResult[];

    if (runtimeResult.status === "fulfilled") setRuntime(runtimeResult.value);
    if (dashboardResult.status === "fulfilled") setDashboard(dashboardResult.value);
    if (ticketsResult.status === "fulfilled") {
      commitTicketListSnapshot(ticketsResult.value);
    }
    if (clientsResult.status === "fulfilled") setClients(clientsResult.value);
    if (directoryResult.status === "fulfilled") {
      setDirectorySnapshot(directoryResult.value);
    }
    if (categoriesResult.status === "fulfilled") {
      setCategoryCatalog(categoriesResult.value.items);
    }
    if (pendingConversationsResult.status === "fulfilled") {
      setPendingConversations(pendingConversationsResult.value.total);
    }
    if (ticketAssigneesResult.status === "fulfilled") {
      setTicketAssignees(ticketAssigneesResult.value);
    }

    setApiError(failures.length ? failures[0].reason?.message ?? "Falha ao consultar a API local." : null);
    setLoading(false);
    setRefreshing(false);
  }, [commitTicketListSnapshot, requestTicketListSnapshot]);

  const refreshCategoryCatalog = useCallback(async () => {
    try {
      const result = await getCategories();
      setCategoryCatalog(result.items);
      return true;
    } catch (error) {
      showToast({
        tone: "warning",
        message:
          error instanceof Error
            ? error.message
            : "Não foi possível atualizar o catálogo de categorias.",
      });
      return false;
    }
  }, [showToast]);

  useEffect(() => {
    if (!access || (activeView !== "kanban" && activeView !== "inbox")) return;
    let cancelled = false;
    void getTicketAssignees()
      .then((users) => {
        if (!cancelled) setTicketAssignees(users);
      })
      .catch(() => {
        // A carga principal já apresenta erros da API. Esta atualização só
        // mantém a equipe recém-editada sincronizada ao voltar para o fluxo.
      });
    return () => {
      cancelled = true;
    };
  }, [access, activeView]);

  useEffect(() => {
    ticketDetailsRef.current = ticketDetails;
  }, [ticketDetails]);

  const commitTicketSnapshot = useCallback((detail: TicketDetail) => {
    const summary = ticketSummaryFromDetail(detail);
    setTicketDetails((current) => {
      const existing = current.get(detail.id);
      if (hasSameTicketPayload(existing, detail)) return current;
      const next = new Map(current).set(detail.id, detail);
      ticketDetailsRef.current = next;
      return next;
    });
    setTickets((current) => {
      const index = current.findIndex((ticket) => ticket.id === detail.id);
      if (index < 0) return current;
      if (hasSameTicketPayload(current[index], summary)) return current;
      const next = [...current];
      next[index] = summary;
      return next;
    });
  }, []);

  const invalidateTicketSnapshot = useCallback((id: string) => {
    ticketListSnapshotCoordinatorRef.current.invalidate(TICKET_LIST_SNAPSHOT_KEY);
    return ticketSnapshotCoordinatorRef.current.invalidate(id);
  }, []);

  const requestTicketSnapshot = useCallback(
    (id: string) => ticketSnapshotCoordinatorRef.current.request(id, getTicket),
    [],
  );

  const loadSelectedTicket = useCallback(
    async (id: string, force = false, silent = false) => {
      if (!force && ticketDetailsRef.current.has(id)) return;
      await Promise.resolve();
      if (!silent) setDetailLoading(true);
      try {
        const snapshot = await requestTicketSnapshot(id);
        if (ticketSnapshotCoordinatorRef.current.isCurrent(id, snapshot)) {
          commitTicketSnapshot(snapshot.detail);
        }
        setApiError(null);
      } catch (error) {
        setApiError(error instanceof Error ? error.message : "Falha ao abrir o ticket.");
      } finally {
        if (!silent) setDetailLoading(false);
      }
    },
    [commitTicketSnapshot, requestTicketSnapshot],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => void loadData(), 0);
    return () => window.clearTimeout(timer);
  }, [loadData]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setNotificationState(getBrowserNotificationState());
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (activeView !== "inbox" || !currentSelectedId) return;
    const timer = window.setTimeout(
      () => void loadSelectedTicket(currentSelectedId),
      0,
    );
    return () => window.clearTimeout(timer);
  }, [activeView, currentSelectedId, loadSelectedTicket]);

  useEffect(() => {
    if (activeView !== "inbox" || !currentSelectedId) return;
    const ticketId = currentSelectedId;

    let cancelled = false;
    let timer: number | null = null;
    let transientFailures = 0;

    const clearScheduledPoll = () => {
      if (timer === null) return;
      window.clearTimeout(timer);
      timer = null;
    };

    const scheduleNextPoll = () => {
      clearScheduledPoll();
      if (cancelled || document.visibilityState !== "visible") return;
      const current = ticketDetailsRef.current.get(ticketId);
      const baseInterval = isInvestigationActive(current?.latestInvestigation ?? null)
        ? ACTIVE_TICKET_POLL_INTERVAL_MS
        : IDLE_TICKET_POLL_INTERVAL_MS;
      const interval = Math.min(
        baseInterval * 2 ** transientFailures,
        MAX_TICKET_POLL_INTERVAL_MS,
      );
      timer = window.setTimeout(() => void pollTicket(), interval);
    };

    const pollTicket = async () => {
      if (cancelled || document.visibilityState !== "visible") return;
      try {
        const snapshot = await requestTicketSnapshot(ticketId);
        if (
          !cancelled &&
          ticketSnapshotCoordinatorRef.current.isCurrent(ticketId, snapshot)
        ) {
          commitTicketSnapshot(snapshot.detail);
        }
        transientFailures = 0;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          cancelled = true;
          clearScheduledPoll();
          ticketSnapshotCoordinatorRef.current.forget(ticketId);
          setTicketDetails((current) => {
            if (!current.has(ticketId)) return current;
            const next = new Map(current);
            next.delete(ticketId);
            ticketDetailsRef.current = next;
            return next;
          });
          setTickets((current) => current.filter((ticket) => ticket.id !== ticketId));
          setSelectedId((current) => (current === ticketId ? null : current));
          setRouteTicketReference(null);
          setActiveView("kanban");
          window.history.replaceState({}, "", buildThreadmarkPath({ view: "kanban" }));
        } else {
          transientFailures = Math.min(transientFailures + 1, 4);
        }
        // Erros transitórios permanecem silenciosos e tentam novamente no próximo ciclo.
      } finally {
        if (!cancelled) scheduleNextPoll();
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        clearScheduledPoll();
        void pollTicket();
      } else {
        clearScheduledPoll();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    scheduleNextPoll();
    return () => {
      cancelled = true;
      clearScheduledPoll();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [
    activeView,
    commitTicketSnapshot,
    currentSelectedId,
    requestTicketSnapshot,
  ]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void Promise.allSettled([
        getRuntime().then(setRuntime),
        requestTicketListSnapshot().then((snapshot) => {
          commitTicketListSnapshot(snapshot);
        }),
        getDirectory().then(setDirectorySnapshot),
        getCategories().then((result) => setCategoryCatalog(result.items)),
        getConversations({ attention: "pending", limit: 1 }).then((result) =>
          setPendingConversations(result.total),
        ),
      ]);
    }, 30_000);
    return () => window.clearInterval(interval);
  }, [commitTicketListSnapshot, requestTicketListSnapshot]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (!isSupportSearchShortcut(event)) return;
      const modalOpen = document.querySelector(
        '[role="dialog"][aria-modal="true"]',
      );
      if (resolutionTarget || (modalOpen && !investigationRoomTarget)) return;
      handleSupportSearchShortcut(event, focusTicketSearch);
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [focusTicketSearch, investigationRoomTarget, resolutionTarget]);

  const persistStatusChange = useCallback(
    async (ticketId: string, status: TicketStatus, resolution?: string) => {
      setUpdatingStatus(true);
      invalidateTicketSnapshot(ticketId);
      try {
        const updated = await updateTicketStatus(ticketId, status, resolution);
        invalidateTicketSnapshot(ticketId);
        commitTicketSnapshot(updated);
        showToast({
          tone: "success",
          message:
            status === "resolved"
              ? "Ticket marcado como resolvido."
              : "Status interno atualizado.",
        });
        void getDashboard().then(setDashboard);
        return true;
      } catch (error) {
        showToast({
          tone: "warning",
          message: error instanceof Error ? error.message : "Não foi possível alterar o status.",
        });
        return false;
      } finally {
        setUpdatingStatus(false);
      }
    },
    [commitTicketSnapshot, invalidateTicketSnapshot, showToast],
  );

  const requestStatusChange = useCallback(
    (ticketId: string, status: TicketStatus) => {
      if (status === "resolved") {
        const openResolutionDialog = async () => {
          try {
            const cachedTicket = ticketDetailsRef.current.get(ticketId);
            const ticket = cachedTicket ?? (await getTicket(ticketId));
            if (!cachedTicket) commitTicketSnapshot(ticket);
            const previousSummary = ticket.resolution?.summary ?? "";
            setOriginalResolutionSummary(previousSummary);
            setResolutionSummary(previousSummary);
            setResolutionTarget(ticketId);
          } catch (error) {
            showToast({
              tone: "warning",
              message:
                error instanceof Error
                  ? error.message
                  : "Não foi possível carregar a resolução anterior.",
            });
          }
        };
        void openResolutionDialog();
        return;
      }
      void persistStatusChange(ticketId, status);
    },
    [commitTicketSnapshot, persistStatusChange, showToast],
  );

  const handleBulkTicketStatusChange = useCallback(
    async (
      ticketIds: string[],
      status: "archived" | "resolved",
    ): Promise<TicketSummary[] | null> => {
      for (const ticketId of ticketIds) invalidateTicketSnapshot(ticketId);
      try {
        const updated = await bulkUpdateTicketStatus(ticketIds, status);
        for (const ticketId of ticketIds) invalidateTicketSnapshot(ticketId);
        const changedIds = new Set(updated.map((ticket) => ticket.id));
        setTickets((current) => {
          const unchanged = current.filter((ticket) => !changedIds.has(ticket.id));
          return status === "archived" ? unchanged : [...updated, ...unchanged];
        });
        setTicketDetails((current) => {
          const next = new Map(current);
          for (const ticketId of changedIds) next.delete(ticketId);
          return next;
        });
        if (status === "archived") {
          setSelectedId((current) => current && changedIds.has(current) ? null : current);
        }
        void getDashboard().then(setDashboard).catch(() => undefined);
        showToast({
          tone: "success",
          message: status === "archived"
            ? `${updated.length} ${updated.length === 1 ? "ticket arquivado" : "tickets arquivados"}. Nenhum dado foi excluído.`
            : `${updated.length} ${updated.length === 1 ? "ticket restaurado" : "tickets restaurados"} para Resolvidos.`,
        });
        return updated;
      } catch (error) {
        showToast({
          tone: "warning",
          message: error instanceof Error
            ? error.message
            : "Não foi possível atualizar os tickets selecionados.",
        });
        return null;
      }
    },
    [invalidateTicketSnapshot, showToast],
  );

  const handleStatusChange = useCallback(
    (status: TicketStatus) => {
      if (currentSelectedId) requestStatusChange(currentSelectedId, status);
    },
    [currentSelectedId, requestStatusChange],
  );

  const refreshTicket = useCallback(async () => {
    if (!currentSelectedId) return;
    await loadSelectedTicket(currentSelectedId, true);
  }, [currentSelectedId, loadSelectedTicket]);

  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    await loadData();
    setConversationRefreshVersion((current) => current + 1);
  }, [loadData]);

  const refreshTicketCollections = useCallback(async () => {
    const [
      ticketsResult,
      clientsResult,
      directoryResult,
      categoriesResult,
      dashboardResult,
      conversationsResult,
    ] = await Promise.allSettled([
      requestTicketListSnapshot(),
      getClients(),
      getDirectory(),
      getCategories(),
      getDashboard(),
      getConversations({ attention: "pending", limit: 1 }),
    ]);
    if (ticketsResult.status === "fulfilled") {
      commitTicketListSnapshot(ticketsResult.value);
    }
    if (clientsResult.status === "fulfilled") setClients(clientsResult.value);
    if (directoryResult.status === "fulfilled") setDirectorySnapshot(directoryResult.value);
    if (dashboardResult.status === "fulfilled") setDashboard(dashboardResult.value);
    if (categoriesResult.status === "fulfilled") setCategoryCatalog(categoriesResult.value.items);
    if (conversationsResult.status === "fulfilled") {
      setPendingConversations(conversationsResult.value.total);
    }
    setConversationRefreshVersion((current) => current + 1);
  }, [commitTicketListSnapshot, requestTicketListSnapshot]);

  const openManualTicketDialog = useCallback(() => {
    setManualTicketError(null);
    setManualTicketRequestId(crypto.randomUUID());
  }, []);

  const handleCreateManualTicket = useCallback(async (draft: ManualTicketDraft) => {
    if (!manualTicketRequestId || creatingManualTicket) return;
    setCreatingManualTicket(true);
    setManualTicketError(null);
    try {
      const created = await createManualTicket({
        clientRequestId: manualTicketRequestId,
        groupId: draft.groupId,
        title: draft.title,
        summary: draft.summary,
        priority: draft.priority,
      });
      const summary = ticketSummaryFromDetail(created);
      setTicketDetails((current) => {
        const next = new Map(current).set(created.id, created);
        ticketDetailsRef.current = next;
        return next;
      });
      setTickets((current) => [
        summary,
        ...current.filter((ticket) => ticket.id !== created.id),
      ]);
      ticketListSnapshotCoordinatorRef.current.invalidate(TICKET_LIST_SNAPSHOT_KEY);
      setManualTicketRequestId(null);
      setSelectedId(created.id);
      setRouteTicketReference(null);
      setActiveView("inbox");
      window.history.pushState(
        {},
        "",
        buildThreadmarkPath({
          view: "inbox",
          ticketReference: created.number,
        }),
      );
      showToast({
        tone: "success",
        message: `Ticket #${created.number} criado manualmente.`,
      });
      void refreshTicketCollections();
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : "Não foi possível criar o ticket manual.";
      setManualTicketError(message);
      showToast({ tone: "warning", message });
    } finally {
      setCreatingManualTicket(false);
    }
  }, [creatingManualTicket, manualTicketRequestId, refreshTicketCollections, showToast]);

  const openProductForwarding = useCallback(() => {
    if (!selectedTicket) return;
    const existing = selectedTicket.productForwarding;
    const canResolve =
      selectedTicket.status !== "resolved" && selectedTicket.status !== "archived";

    productForwardingReturnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    setProductForwardingTarget({
      ticketId: selectedTicket.id,
      title: existing?.title ?? selectedTicket.title,
      description: existing?.description ?? selectedTicket.summary,
      externalReference: existing?.externalReference ?? "",
      resolveTicket: !existing && canResolve,
      isEditing: Boolean(existing),
      canResolve,
    });
  }, [selectedTicket]);

  const saveProductForwarding = useCallback(async () => {
    if (!productForwardingTarget) return false;
    const title = productForwardingTarget.title.trim();
    const description = productForwardingTarget.description.trim();
    if (!title || !description) return false;

    const input: UpsertTicketProductForwardingInput = {
      kind: "bug",
      title,
      description,
      externalReference: productForwardingTarget.externalReference.trim() || null,
      resolveTicket:
        productForwardingTarget.canResolve && productForwardingTarget.resolveTicket,
    };

    setSavingProductForwarding(true);
    invalidateTicketSnapshot(productForwardingTarget.ticketId);
    try {
      const updated = await upsertTicketProductForwarding(
        productForwardingTarget.ticketId,
        input,
      );
      invalidateTicketSnapshot(productForwardingTarget.ticketId);
      commitTicketSnapshot(updated);
      const dashboardResult = await Promise.allSettled([getDashboard()]);
      if (dashboardResult[0].status === "fulfilled") {
        setDashboard(dashboardResult[0].value);
      }
      showToast({
        tone: "success",
        message: productForwardingTarget.isEditing
          ? "Encaminhamento para Produto atualizado."
          : input.resolveTicket
            ? "Bug encaminhado e atendimento finalizado."
            : "Bug encaminhado para Produto.",
      });
      setProductForwardingTarget(null);
      return true;
    } catch (error) {
      showToast({
        tone: "warning",
        message:
          error instanceof Error
            ? error.message
            : "Não foi possível salvar o encaminhamento para Produto.",
      });
      return false;
    } finally {
      setSavingProductForwarding(false);
    }
  }, [commitTicketSnapshot, invalidateTicketSnapshot, productForwardingTarget, showToast]);

  const syncInvestigationThread = useCallback((thread: InvestigationThreadDto) => {
    setInvestigationThread(thread);
    setTicketDetails((current) => {
      const ticket = current.get(thread.ticketId);
      if (!ticket) return current;
      return new Map(current).set(thread.ticketId, {
        ...ticket,
        investigationThread: {
          id: thread.id,
          status: thread.status,
          updatedAt: thread.updatedAt,
          lastAssistantMessageAt: thread.lastAssistantMessageAt,
          activeTurnState: thread.activeTurnState,
        },
      });
    });
  }, []);

  const openInvestigationRoom = useCallback(async () => {
    if (!currentSelectedId) return;
    invalidateTicketSnapshot(currentSelectedId);
    setInvestigationRoomTarget(currentSelectedId);
    setInvestigationThread(null);
    setInvestigationRoomError(null);
    setInvestigationRoomLoading(true);
    try {
      const thread = await openInvestigationThread(currentSelectedId);
      invalidateTicketSnapshot(currentSelectedId);
      syncInvestigationThread(thread);
    } catch (error) {
      setInvestigationRoomError(
        error instanceof Error
          ? error.message
          : "Não foi possível abrir a sala de investigação.",
      );
    } finally {
      setInvestigationRoomLoading(false);
    }
  }, [currentSelectedId, invalidateTicketSnapshot, syncInvestigationThread]);

  const refreshInvestigationRoom = useCallback(
    async (silent = false) => {
      if (!investigationRoomTarget && !investigationThread) return;
      const ticketId = investigationThread?.ticketId ?? investigationRoomTarget;
      if (!ticketId) return;
      if (!silent) setInvestigationRoomLoading(true);
      setInvestigationRoomError(null);
      try {
        const [threadResult, ticketResult] = await Promise.allSettled([
          investigationThread
            ? getInvestigationThread(investigationThread.id)
            : openInvestigationThread(ticketId),
          requestTicketSnapshot(ticketId),
        ]);
        if (
          ticketResult.status === "fulfilled" &&
          ticketSnapshotCoordinatorRef.current.isCurrent(
            ticketId,
            ticketResult.value,
          )
        ) {
          commitTicketSnapshot(ticketResult.value.detail);
        }
        if (threadResult.status === "rejected") throw threadResult.reason;
        syncInvestigationThread(threadResult.value);
        if (ticketResult.status === "rejected") throw ticketResult.reason;
      } catch (error) {
        setInvestigationRoomError(
          error instanceof Error
            ? error.message
            : "Não foi possível atualizar a sala de investigação.",
        );
      } finally {
        if (!silent) setInvestigationRoomLoading(false);
      }
    },
    [
      commitTicketSnapshot,
      investigationRoomTarget,
      investigationThread,
      requestTicketSnapshot,
      syncInvestigationThread,
    ],
  );

  const sendInvestigationRoomMessage = useCallback(
    async (body: string, clientMessageId: string): Promise<boolean> => {
      if (!investigationThread) return false;
      invalidateTicketSnapshot(investigationThread.ticketId);
      setInvestigationRoomSending(true);
      setInvestigationRoomError(null);
      try {
        const thread = await addInvestigationThreadMessage(
          investigationThread.id,
          body,
          clientMessageId,
        );
        invalidateTicketSnapshot(investigationThread.ticketId);
        syncInvestigationThread(thread);
        return true;
      } catch (error) {
        setInvestigationRoomError(
          error instanceof Error
            ? error.message
            : "Não foi possível registrar a mensagem da investigação.",
        );
        return false;
      } finally {
        setInvestigationRoomSending(false);
      }
    },
    [investigationThread, invalidateTicketSnapshot, syncInvestigationThread],
  );

  const stopInvestigationRoom = useCallback(async () => {
    if (!investigationThread || investigationRoomStopping) return;
    setInvestigationRoomStopping(true);
    setInvestigationRoomError(null);
    try {
      const thread = await cancelInvestigationThread(investigationThread.id);
      invalidateTicketSnapshot(thread.ticketId);
      syncInvestigationThread(thread);
      showToast({
        tone: "success",
        message: "Investigação interrompida. Todo o histórico foi preservado.",
      });
    } catch (error) {
      setInvestigationRoomError(
        error instanceof Error
          ? error.message
          : "Não foi possível interromper a investigação.",
      );
    } finally {
      setInvestigationRoomStopping(false);
    }
  }, [
    investigationRoomStopping,
    investigationThread,
    invalidateTicketSnapshot,
    showToast,
    syncInvestigationThread,
  ]);

  useEffect(() => {
    if (!investigationThread) return;
    const active = isInvestigationTurnActive(investigationThread.activeTurnState);
    if (!investigationRoomTarget && !active) return;
    const interval = window.setInterval(() => {
      void refreshInvestigationRoom(true);
    }, active ? 2_000 : 5_000);
    return () => window.clearInterval(interval);
  }, [investigationRoomTarget, investigationThread, refreshInvestigationRoom]);

  useEffect(() => {
    const previousState = previousRoomTurnStateRef.current;
    const currentState = investigationThread?.activeTurnState ?? null;
    if (
      investigationThread &&
      isInvestigationTurnActive(previousState) &&
      !isInvestigationTurnActive(currentState)
    ) {
      void loadSelectedTicket(investigationThread.ticketId, true, true);
      const latestTurn = investigationThread.turns.at(-1);
      if (
        notificationState === "enabled" &&
        latestTurn &&
        isFinishedInvestigationState(latestTurn.state)
      ) {
        const ticket = ticketDetails.get(investigationThread.ticketId);
        showBrowserNotification({
          title: getInvestigationNotificationTitle("deep", latestTurn.state),
          body: ticket
            ? `#${ticket.number} · ${ticket.client.name}\n${ticket.title}`
            : "O turno da sala de investigação foi finalizado.",
          tag: `threadmark:deep:${latestTurn.id}:${latestTurn.state}`,
          onClick: () => {
            setSelectedId(investigationThread.ticketId);
            setRouteTicketReference(null);
            setActiveView("inbox");
            setInvestigationRoomTarget(investigationThread.ticketId);
            setSidebarOpen(false);
            window.history.pushState(
              {},
              "",
              buildThreadmarkPath({
                view: "inbox",
                ticketReference: ticket?.number ?? investigationThread.ticketId,
              }),
            );
          },
        });
      }
    }
    previousRoomTurnStateRef.current = currentState;
  }, [investigationThread, loadSelectedTicket, notificationState, ticketDetails]);

  const toggleNotifications = useCallback(async () => {
    if (notificationState === "enabled") {
      setNotificationState(disableBrowserNotifications());
      showToast({
        tone: "success",
        message: "Notificações da sala de investigação desativadas.",
      });
      return;
    }

    const nextState = await enableBrowserNotifications();
    setNotificationState(nextState);
    if (nextState === "enabled") {
      showToast({
        tone: "success",
        message: "Notificações ativadas. Você será avisado quando o Codex terminar.",
      });
      return;
    }

    showToast({
      tone: "warning",
      message:
        nextState === "blocked"
          ? "As notificações estão bloqueadas. Libere o localhost nos ajustes do navegador."
          : "Este navegador não disponibilizou notificações locais.",
    });
  }, [notificationState, showToast]);

  const reloadDirectory = useCallback(async () => {
    const snapshot = await getDirectory();
    setDirectorySnapshot(snapshot);
  }, []);

  const handleCreateCategory = useCallback(
    async (input: {
      facet: CategoryFacetType;
      label: string;
      color?: string;
    }) => {
      try {
        const created = await createCategory({
          facet: input.facet,
          label: input.label.trim(),
          color: input.color?.trim() || null,
        });
        setCategoryCatalog((current) => {
          const exists = current.some((category) => category.id === created.id);
          if (exists) return current;
          return [...current, created];
        });
        showToast({
          tone: "success",
          message: `Categoria "${created.label}" criada no catálogo.`,
        });
        return created;
      } catch (error) {
        showToast({
          tone: "warning",
          message:
            error instanceof Error
              ? error.message
              : "Não foi possível criar a categoria.",
        });
        throw error;
      }
    },
    [showToast],
  );

  const handleAttachCategory = useCallback(
    async (ticketId: string, categoryId: string) => {
      if (!categoryId) return false;
      setCategoryMutationTicketId(ticketId);
      invalidateTicketSnapshot(ticketId);
      try {
        const updated = await attachCategoryToTicket(ticketId, {
          categoryId,
          actor: "Operador local",
        });
        invalidateTicketSnapshot(ticketId);
        commitTicketSnapshot(updated);
        await refreshCategoryCatalog();
        showToast({
          tone: "success",
          message: "Categoria vinculada ao ticket.",
        });
        return true;
      } catch (error) {
        showToast({
          tone: "warning",
          message:
            error instanceof Error
              ? error.message
              : "Não foi possível vincular a categoria ao ticket.",
        });
        return false;
      } finally {
        setCategoryMutationTicketId((current) =>
          current === ticketId ? null : current,
        );
      }
    },
    [commitTicketSnapshot, invalidateTicketSnapshot, refreshCategoryCatalog, showToast],
  );

  const handleDetachCategory = useCallback(
    async (ticketId: string, categoryId: string) => {
      if (!categoryId) return false;
      setCategoryMutationTicketId(ticketId);
      invalidateTicketSnapshot(ticketId);
      try {
        const updated = await detachCategoryFromTicket(ticketId, categoryId);
        invalidateTicketSnapshot(ticketId);
        commitTicketSnapshot(updated);
        await refreshCategoryCatalog();
        showToast({
          tone: "success",
          message: "Categoria removida do ticket.",
        });
        return true;
      } catch (error) {
        showToast({
          tone: "warning",
          message:
            error instanceof Error
              ? error.message
              : "Não foi possível remover a categoria do ticket.",
        });
        return false;
      } finally {
        setCategoryMutationTicketId((current) =>
          current === ticketId ? null : current,
        );
      }
    },
    [commitTicketSnapshot, invalidateTicketSnapshot, refreshCategoryCatalog, showToast],
  );

  const handleUpdateTicketMetadata = useCallback(
    async (ticketId: string, input: UpdateTicketMetadataInput) => {
      setUpdatingTicketMetadata(true);
      invalidateTicketSnapshot(ticketId);
      try {
        const updated = await updateTicketMetadata(ticketId, input);
        invalidateTicketSnapshot(ticketId);
        commitTicketSnapshot(updated);

        const [ticketsResult, dashboardResult] = await Promise.allSettled([
          requestTicketListSnapshot(),
          getDashboard(),
        ]);
        if (ticketsResult.status === "fulfilled") {
          commitTicketListSnapshot(ticketsResult.value);
        }
        if (dashboardResult.status === "fulfilled") {
          setDashboard(dashboardResult.value);
        }
        showToast({
          tone: "success",
          message: "Dados do ticket atualizados no SQLite.",
        });
        return true;
      } catch (error) {
        showToast({
          tone: "warning",
          message:
            error instanceof Error
              ? error.message
              : "Não foi possível atualizar os dados do ticket.",
        });
        return false;
      } finally {
        setUpdatingTicketMetadata(false);
      }
    },
    [
      commitTicketListSnapshot,
      commitTicketSnapshot,
      invalidateTicketSnapshot,
      requestTicketListSnapshot,
      showToast,
    ],
  );

  const handleUpdateTicketAssignee = useCallback(
    async (ticketId: string, assigneeId: string | null) => {
      setAssigningTicketId(ticketId);
      invalidateTicketSnapshot(ticketId);
      try {
        const updated = await updateTicketAssignee(ticketId, { assigneeId });
        invalidateTicketSnapshot(ticketId);
        commitTicketSnapshot(updated);
        const assignee = assigneeId
          ? ticketAssignees.find((candidate) => candidate.id === assigneeId)
          : null;
        showToast({
          tone: "success",
          message: assignee
            ? `Ticket atribuído a ${assignee.displayName}.`
            : "Ticket deixado sem responsável.",
        });
        return true;
      } catch (error) {
        showToast({
          tone: "warning",
          message:
            error instanceof Error
              ? error.message
              : "Não foi possível atualizar o responsável do ticket.",
        });
        return false;
      } finally {
        setAssigningTicketId(null);
      }
    },
    [
      commitTicketSnapshot,
      invalidateTicketSnapshot,
      showToast,
      ticketAssignees,
    ],
  );

  const handleAddTicketNote = useCallback(
    async (ticketId: string, body: string, clientNoteId: string) => {
      setAddingTicketNote(true);
      invalidateTicketSnapshot(ticketId);
      try {
        const updated = await addTicketInternalNote(ticketId, body, clientNoteId);
        invalidateTicketSnapshot(ticketId);
        commitTicketSnapshot(updated);
        showToast({
          tone: "success",
          message: "Nota interna salva no histórico do ticket.",
        });
        return true;
      } catch (error) {
        showToast({
          tone: "warning",
          message:
            error instanceof Error
              ? error.message
              : "Não foi possível salvar a nota interna.",
        });
        return false;
      } finally {
        setAddingTicketNote(false);
      }
    },
    [commitTicketSnapshot, invalidateTicketSnapshot, showToast],
  );

  const handleUpdateTicketNote = useCallback(
    async (
      ticketId: string,
      noteId: string,
      body: string,
      expectedUpdatedAt: string,
    ) => {
      setTicketNoteMutation({ noteId, action: "edit" });
      invalidateTicketSnapshot(ticketId);
      try {
        const updated = await updateTicketInternalNote(ticketId, noteId, {
          body,
          expectedUpdatedAt,
        });
        invalidateTicketSnapshot(ticketId);
        commitTicketSnapshot(updated);
        showToast({ tone: "success", message: "Nota interna atualizada." });
        return true;
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          invalidateTicketSnapshot(ticketId);
          await loadSelectedTicket(ticketId, true, true);
          showToast({
            tone: "warning",
            message:
              "Esta nota mudou em outra tela. O conteúdo mais recente foi carregado; revise antes de salvar novamente.",
          });
          return false;
        }
        showToast({
          tone: "warning",
          message:
            error instanceof Error
              ? error.message
              : "Não foi possível atualizar a nota interna.",
        });
        return false;
      } finally {
        setTicketNoteMutation((current) =>
          current?.noteId === noteId && current.action === "edit" ? null : current,
        );
      }
    },
    [
      commitTicketSnapshot,
      invalidateTicketSnapshot,
      loadSelectedTicket,
      showToast,
    ],
  );

  const handleDeleteTicketNote = useCallback(
    async (ticketId: string, noteId: string) => {
      setTicketNoteMutation({ noteId, action: "delete" });
      invalidateTicketSnapshot(ticketId);
      try {
        const updated = await deleteTicketInternalNote(ticketId, noteId);
        invalidateTicketSnapshot(ticketId);
        commitTicketSnapshot(updated);
        showToast({
          tone: "success",
          message: "Nota interna excluída da timeline. A ação permaneceu auditada.",
        });
        return true;
      } catch (error) {
        showToast({
          tone: "warning",
          message:
            error instanceof Error
              ? error.message
              : "Não foi possível excluir a nota interna.",
        });
        return false;
      } finally {
        setTicketNoteMutation((current) =>
          current?.noteId === noteId && current.action === "delete" ? null : current,
        );
      }
    },
    [commitTicketSnapshot, invalidateTicketSnapshot, showToast],
  );

  const handleDetachTicketMessage = useCallback(
    async (ticketId: string, messageId: string) => {
      setDetachingTicketMessageId(messageId);
      invalidateTicketSnapshot(ticketId);
      try {
        const updated = await detachTicketMessage(ticketId, messageId);
        invalidateTicketSnapshot(ticketId);
        commitTicketSnapshot(updated);
        showToast({
          tone: "success",
          message:
            "Mensagem desvinculada do ticket. Ela continua salva em Conversas e no SQLite.",
        });
        return true;
      } catch (error) {
        showToast({
          tone: "warning",
          message:
            error instanceof Error
              ? error.message
              : "Não foi possível desvincular a mensagem do ticket.",
        });
        return false;
      } finally {
        setDetachingTicketMessageId((current) =>
          current === messageId ? null : current,
        );
      }
    },
    [commitTicketSnapshot, invalidateTicketSnapshot, showToast],
  );

  const handleDeleteTicket = useCallback(
    async (ticketId: string) => {
      const ticketNumber =
        ticketDetails.get(ticketId)?.number ??
        tickets.find((ticket) => ticket.id === ticketId)?.number;
      setDeletingTicketId(ticketId);
      invalidateTicketSnapshot(ticketId);

      try {
        await deleteTicket(ticketId);
        ticketSnapshotCoordinatorRef.current.forget(ticketId);
        ticketListSnapshotCoordinatorRef.current.invalidate(TICKET_LIST_SNAPSHOT_KEY);

        const remainingTickets = tickets.filter((ticket) => ticket.id !== ticketId);

        setTickets(remainingTickets);
        setTicketDetails((current) => {
          const next = new Map(current);
          next.delete(ticketId);
          ticketDetailsRef.current = next;
          return next;
        });
        setSelectedId(null);
        setRouteTicketReference(null);
        setActiveView("kanban");
        window.history.replaceState({}, "", buildThreadmarkPath({ view: "kanban" }));
        setResolutionTarget((current) => (current === ticketId ? null : current));
        if (investigationRoomTarget === ticketId) {
          setInvestigationRoomTarget(null);
          setInvestigationThread(null);
          setInvestigationRoomError(null);
          setRoomSearchOpen(false);
        }
        const [ticketsResult, clientsResult, dashboardResult] =
          await Promise.allSettled([
            requestTicketListSnapshot(),
            getClients(),
            getDashboard(),
          ]);
        if (ticketsResult.status === "fulfilled") {
          commitTicketListSnapshot(ticketsResult.value);
        }
        if (clientsResult.status === "fulfilled") setClients(clientsResult.value);
        if (dashboardResult.status === "fulfilled") setDashboard(dashboardResult.value);

        showToast({
          tone: "success",
          message: `${ticketNumber ? `Ticket #${ticketNumber}` : "Ticket"} excluído permanentemente. A conversa original do WhatsApp foi preservada.`,
        });
        return true;
      } catch (error) {
        showToast({
          tone: "warning",
          message:
            error instanceof Error
              ? error.message
              : "Não foi possível excluir o ticket permanentemente.",
        });
        return false;
      } finally {
        setDeletingTicketId(null);
      }
    },
    [
      investigationRoomTarget,
      commitTicketListSnapshot,
      invalidateTicketSnapshot,
      requestTicketListSnapshot,
      showToast,
      ticketDetails,
      tickets,
    ],
  );

  const openTicket = useCallback((id: string) => {
    const ticket =
      ticketDetails.get(id) ?? tickets.find((candidate) => candidate.id === id);
    setSelectedId(id);
    setRouteTicketReference(null);
    setActiveView("inbox");
    setSidebarOpen(false);
    const path = buildThreadmarkPath({
      view: "inbox",
      ticketReference: ticket?.number ?? id,
    });
    if (`${window.location.pathname}${window.location.search}` !== path) {
      window.history.pushState({}, "", path);
    }
  }, [ticketDetails, tickets]);

  const openSettingsTab = useCallback((tab: SettingsTab) => {
    navigateToView("settings", { settingsTab: tab });
  }, [navigateToView]);

  const currentPage = pageContent[activeView];
  const pageView = useMemo(() => {
    switch (activeView) {
      case "conversations":
        return (
          <ConversationsView
            clients={clients}
            onOpenAiSettings={() => openSettingsTab("ai")}
            onOpenTicket={openTicket}
            onTicketsChanged={refreshTicketCollections}
            onToast={showToast}
            refreshVersion={conversationRefreshVersion}
            tickets={tickets}
          />
        );
      case "inbox":
        return (
          <div className="h-full min-h-0 bg-card">
            <TicketDetailPanel
              addingNote={addingTicketNote}
              assignees={ticketAssignees}
              canManageNotes={Boolean(
                access && access.user.role !== "viewer",
              )}
              canEditTicket={Boolean(access && access.user.role !== "viewer")}
              currentUserId={access?.user.id ?? null}
              deleting={deletingTicketId === selectedTicket?.id}
              detachingMessageId={detachingTicketMessageId}
              key={selectedTicket?.id ?? "empty-ticket"}
              loading={detailLoading}
              onAddNote={handleAddTicketNote}
              onBackToKanban={() => navigateToView("kanban")}
              onDelete={handleDeleteTicket}
              onDetachMessage={handleDetachTicketMessage}
              onDeleteNote={handleDeleteTicketNote}
              onOpenInvestigationRoom={openInvestigationRoom}
              onOpenCategoryCatalog={() => navigateToView("categories")}
              onOpenProductForwarding={openProductForwarding}
              onRefresh={refreshTicket}
              onStatusChange={handleStatusChange}
              onUpdateNote={handleUpdateTicketNote}
              onUpdateMetadata={handleUpdateTicketMetadata}
              onUpdateAssignee={handleUpdateTicketAssignee}
              onAttachCategory={handleAttachCategory}
              onDetachCategory={handleDetachCategory}
              onCreateCategory={handleCreateCategory}
              categoryCatalog={categoryCatalog}
              categoryMutationTicketId={categoryMutationTicketId}
              canManageCategories={Boolean(access && access.user.role !== "viewer")}
              ticket={selectedTicket}
              ticketNoteMutation={ticketNoteMutation}
              updatingMetadata={updatingTicketMetadata}
              updatingAssignee={assigningTicketId === selectedTicket?.id}
              updatingStatus={updatingStatus}
            />
          </div>
        );
      case "kanban":
        return (
          <KanbanView
            assignees={ticketAssignees}
            assigningTicketId={assigningTicketId}
            canAssignTicket={Boolean(access && access.user.role !== "viewer")}
            canCreateTicket={Boolean(access && access.user.role !== "viewer")}
            currentUserId={access?.user.id ?? null}
            loading={loading}
            onBulkStatusChange={handleBulkTicketStatusChange}
            onCreateManualTicket={openManualTicketDialog}
            onMoveTicket={requestStatusChange}
            onOpenTicket={openTicket}
            onAssignTicket={handleUpdateTicketAssignee}
            tickets={tickets}
          />
        );
      case "clients":
        return (
          <DirectoryView
            loading={loading}
            onReload={reloadDirectory}
            snapshot={directorySnapshot}
          />
        );
      case "categories":
        return (
          <CategoriesView
            categories={categoryCatalog}
            loading={loading}
            onCreate={handleCreateCategory}
          />
        );
      case "dashboard":
        return (
          <DashboardView
            dashboard={dashboard}
            loading={loading}
            onOpenInbox={() => navigateToView("kanban")}
            onOpenTicket={openTicket}
            timeZone={workspaceTimeZone}
          />
        );
      case "settings":
        return (
          <SettingsView
            currentUserId={access?.user.id ?? ""}
            currentUserRole={access?.user.role ?? "viewer"}
            initialTab={settingsInitialTab}
            onLogout={() => access?.logout() ?? Promise.resolve()}
            onOpenMenu={() => setSidebarOpen(true)}
            onTabChange={openSettingsTab}
            onWorkspaceChange={(workspace) => {
              setWorkspaceLabel(workspace.workspaceName);
              setWorkspaceTimeZone(workspace.timezone);
            }}
          />
        );
    }
  }, [
    activeView,
    access,
    addingTicketNote,
    categoryCatalog,
    categoryMutationTicketId,
    clients,
    conversationRefreshVersion,
    dashboard,
    directorySnapshot,
    deletingTicketId,
    detachingTicketMessageId,
    detailLoading,
    handleAddTicketNote,
    handleBulkTicketStatusChange,
    handleCreateCategory,
    handleDeleteTicket,
    handleDetachTicketMessage,
    handleAttachCategory,
    handleDetachCategory,
    handleDeleteTicketNote,
    handleStatusChange,
    handleUpdateTicketMetadata,
    handleUpdateTicketAssignee,
    handleUpdateTicketNote,
    loading,
    navigateToView,
    openTicket,
    openSettingsTab,
    openProductForwarding,
    openInvestigationRoom,
    openManualTicketDialog,
    refreshTicket,
    requestStatusChange,
    reloadDirectory,
    refreshTicketCollections,
    selectedTicket,
    ticketAssignees,
    assigningTicketId,
    settingsInitialTab,
    showToast,
    tickets,
    ticketNoteMutation,
    updatingTicketMetadata,
    updatingStatus,
    workspaceTimeZone,
  ]);

  return (
    <div className="h-dvh min-h-0 overflow-hidden bg-muted/40">
      <Sidebar
        activeView={activeView}
        onClose={() => setSidebarOpen(false)}
        onNavigate={(view) => {
          navigateToView(view);
        }}
        open={sidebarOpen}
        pendingConversations={pendingConversations}
        reviewTickets={reviewTickets}
        runtime={runtime}
        operatorName={access?.user.displayName ?? "Operador local"}
        operatorRole={
          {
            owner: "Proprietário",
            admin: "Administrador",
            operator: "Operador",
            viewer: "Visualizador",
          }[access?.user.role ?? "viewer"]
        }
        workspaceName={workspaceLabel}
      />
      <main className="ml-[238px] flex h-dvh min-h-0 flex-col overflow-hidden transition-[margin] max-md:ml-0">
        {activeView !== "settings" && activeView !== "inbox" ? (
          <PageHeader
            notificationState={notificationState}
            onOpenMenu={() => setSidebarOpen(true)}
            onRefresh={() => void refreshAll()}
            onToggleNotifications={() => void toggleNotifications()}
            refreshing={refreshing}
            runtime={runtime}
            subtitle={currentPage.subtitle}
            title={currentPage.title}
          />
        ) : null}
        {apiError ? <ApiErrorBanner message={apiError} onRetry={() => void refreshAll()} /> : null}
        <div
          className={`min-h-0 flex-1 bg-muted/30 ${
            activeView === "conversations" || activeView === "inbox"
              ? "overflow-hidden"
              : "overflow-y-auto"
          }`}
        >
          {pageView}
        </div>
      </main>
      {toast ? (
        <div
          className={`fixed bottom-5 right-5 z-[200] flex max-w-sm items-center gap-2 rounded-xl border bg-card px-4 py-3 text-sm font-medium shadow-xl max-[520px]:left-3 max-[520px]:right-3 ${
            toast.tone === "success"
              ? "border-emerald-200 text-emerald-700"
              : "border-amber-200 text-amber-700"
          }`}
          role="status"
        >
          {toast.tone === "success" ? <CheckCircle2 size={17} /> : <AlertCircle size={17} />}
          <span>{toast.message}</span>
        </div>
      ) : null}
      {manualTicketRequestId ? (
        <ManualTicketDialog
          busy={creatingManualTicket}
          clients={clients}
          error={manualTicketError}
          key={manualTicketRequestId}
          onCancel={() => {
            if (creatingManualTicket) return;
            setManualTicketRequestId(null);
            setManualTicketError(null);
          }}
          onCreate={(draft) => void handleCreateManualTicket(draft)}
        />
      ) : null}
      {resolutionTarget ? (
        <TicketResolutionDialog
          busy={updatingStatus}
          hasPreviousResolution={Boolean(originalResolutionSummary.trim())}
          isSummaryChanged={
            resolutionSummary.trim() !== originalResolutionSummary.trim()
          }
          onCancel={() => {
            setResolutionTarget(null);
            setResolutionSummary("");
            setOriginalResolutionSummary("");
          }}
          onChange={setResolutionSummary}
          onSubmit={() => {
            const summary = resolutionSummary.trim();
            if (!summary) return;
            const previousSummary = originalResolutionSummary.trim();
            const summaryToPersist =
              previousSummary && summary === previousSummary ? undefined : summary;
            void persistStatusChange(
              resolutionTarget,
              "resolved",
              summaryToPersist,
            ).then(
              (saved) => {
                if (saved) {
                  setResolutionTarget(null);
                  setResolutionSummary("");
                  setOriginalResolutionSummary("");
                }
              },
            );
          }}
          summary={resolutionSummary}
        />
      ) : null}
      {productForwardingTarget ? (
        <ProductForwardingDialog
          busy={savingProductForwarding}
          draft={productForwardingTarget}
          onCancel={() => setProductForwardingTarget(null)}
          onChange={setProductForwardingTarget}
          onSubmit={() => void saveProductForwarding()}
          returnFocusRef={productForwardingReturnFocusRef}
        />
      ) : null}
      {investigationRoomTicket ? (
        <InvestigationRoom
          error={investigationRoomError}
          loading={investigationRoomLoading}
          onClose={() => {
            setRoomSearchOpen(false);
            setInvestigationRoomTarget(null);
            setInvestigationRoomError(null);
          }}
          onRefresh={() => void refreshInvestigationRoom()}
          onSend={sendInvestigationRoomMessage}
          onStop={() => void stopInvestigationRoom()}
          sending={investigationRoomSending}
          stopping={investigationRoomStopping}
          thread={investigationThread}
          ticket={investigationRoomTicket}
        />
      ) : null}
      {roomSearchOpen ? (
        <SupportSearchOverlay
          onClose={() => setRoomSearchOpen(false)}
          onOpenTicket={(ticketId) => {
            setRoomSearchOpen(false);
            if (ticketId === investigationRoomTarget) return;
            setInvestigationRoomTarget(null);
            setInvestigationRoomError(null);
            openTicket(ticketId);
          }}
          tickets={tickets}
        />
      ) : null}
    </div>
  );
}
