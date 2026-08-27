"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, LoaderCircle } from "lucide-react";
import dynamic from "next/dynamic";
import {
  ApiError,
  addTicketInternalNote,
  attachCategoryToTicket,
  createCategory,
  deleteCategory,
  detachCategoryFromTicket,
  getCategories,
  bulkUpdateTicketStatus,
  createManualTicket,
  deleteTicket,
  deleteTicketInternalNote,
  detachTicketMessage,
  getClients,
  getConversations,
  getDashboard,
  getDirectory,
  getNotifications,
  getRuntime,
  getTicket,
  getTicketAssignees,
  getTickets,
  queueTicketDocumentation,
  upsertTicketProductForwarding,
  updateTicketInternalNote,
  updateTicketMetadata,
  updateTicketAssignee,
  updateNotificationRead,
  updateTicketStatus,
} from "./lib/api";
import type {
  ClientSummary,
  DashboardData,
  CategoryFacetType,
  TicketCategoryCatalog,
  DirectorySnapshot,
  RuntimeState,
  TicketDetail,
  TicketAssignee,
  TicketStatus,
  TicketSummary,
} from "./lib/types";
import {
  type UpsertTicketProductForwardingInput,
  type UpdateTicketMetadataInput,
  type NotificationDto,
} from "@/shared/contracts";
import { activeStatuses, configureSupportTimeZone, statusLabels } from "./lib/format";
import { isInvestigationActive } from "./lib/investigation";
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
import {
  collectNotificationArrivals,
  NotificationLivePreview,
} from "./features/notifications";
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
const ThreadmarkAi = dynamic(
  () => import("./features/threadmark-ai").then((module) => module.ThreadmarkAi),
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
const DocumentationView = dynamic(
  () => import("./features/documentation").then((module) => module.DocumentationView),
  { loading: () => <FeatureLoading label="Carregando documentações…" /> },
);
const AutomationsView = dynamic(
  () => import("./features/automations").then((module) => module.AutomationsView),
  { loading: () => <FeatureLoading label="Carregando automações…" /> },
);
const NotificationsView = dynamic(
  () => import("./features/notifications").then((module) => module.NotificationsView),
  { loading: () => <FeatureLoading label="Carregando notificações…" /> },
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
  documentation: {
    title: "Documentações",
    subtitle: "Rascunhos gerados a partir de tickets resolvidos e revisados por você",
  },
  automations: {
    title: "Automações",
    subtitle: "Crie fluxos internos e conecte apps com execução local auditável",
  },
  notifications: {
    title: "Notificações",
    subtitle: "Avisos internos das automações, investigações e do Threadmark",
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
const NOTIFICATION_POLL_INTERVAL_MS = 5_000;

export function SupportApp({
  initialPath = "/conversations",
}: {
  initialPath?: string;
}) {
  const access = useAppAccess();
  const initialNavigation = parseThreadmarkLocation(initialPath);
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
  const [generatingDocumentationTicketId, setGeneratingDocumentationTicketId] = useState<string | null>(null);
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
  const [roomSearchOpen, setRoomSearchOpen] = useState(false);
  const [unreadNotifications, setUnreadNotifications] = useState(0);
  const [notificationPreviewQueue, setNotificationPreviewQueue] = useState<
    NotificationDto[]
  >([]);
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
  const notificationBaselineReadyRef = useRef(false);
  const knownNotificationIdsRef = useRef<Set<string>>(new Set());

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

  const accessUserId = access?.user.id ?? null;

  useEffect(() => {
    if (!accessUserId) return;
    let active = true;
    notificationBaselineReadyRef.current = false;
    knownNotificationIdsRef.current = new Set();

    const refreshNotifications = () => {
      void getNotifications({ limit: 20 })
        .then((result) => {
          if (!active) return;
          setUnreadNotifications(result.unread);
          if (!notificationBaselineReadyRef.current) {
            setNotificationPreviewQueue([]);
          }
          const snapshot = collectNotificationArrivals(
            result.items,
            knownNotificationIdsRef.current,
            notificationBaselineReadyRef.current,
          );
          knownNotificationIdsRef.current = snapshot.knownIds;
          notificationBaselineReadyRef.current = true;
          if (!snapshot.arrivals.length) return;
          setNotificationPreviewQueue((current) => {
            const queuedIds = new Set(current.map((item) => item.id));
            return [
              ...current,
              ...snapshot.arrivals.filter((item) => !queuedIds.has(item.id)),
            ];
          });
        })
        .catch(() => undefined);
    };
    refreshNotifications();
    const timer = window.setInterval(
      refreshNotifications,
      NOTIFICATION_POLL_INTERVAL_MS,
    );
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [accessUserId]);

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
      if (resolutionTarget || modalOpen) return;
      handleSupportSearchShortcut(event, focusTicketSearch);
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [focusTicketSearch, resolutionTarget]);

  const persistStatusChange = useCallback(
    async (ticketId: string, status: TicketStatus, resolution?: string) => {
      const previousStatus = ticketDetailsRef.current.get(ticketId)?.status;
      setUpdatingStatus(true);
      invalidateTicketSnapshot(ticketId);
      try {
        const updated = await updateTicketStatus(ticketId, status, resolution);
        invalidateTicketSnapshot(ticketId);
        commitTicketSnapshot(updated);
        if (previousStatus === "archived" && status === "resolved") {
          const restoredSummary = ticketSummaryFromDetail(updated);
          setTickets((current) =>
            current.some((ticket) => ticket.id === ticketId)
              ? current.map((ticket) =>
                  ticket.id === ticketId ? restoredSummary : ticket,
                )
              : [restoredSummary, ...current],
          );
        }
        showToast({
          tone: "success",
          message:
            previousStatus === "archived" && status === "resolved"
              ? `Ticket restaurado para ${statusLabels[updated.status]}.`
              : status === "resolved"
              ? "Ticket marcado como resolvido."
              : status === "cancelled"
                ? "Ticket cancelado."
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
      const currentStatus = ticketDetailsRef.current.get(ticketId)?.status;
      if (currentStatus === "archived" && status === "resolved") {
        void persistStatusChange(ticketId, status);
        return;
      }
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
            : `${updated.length} ${updated.length === 1 ? "ticket restaurado" : "tickets restaurados"} ao estado anterior.`,
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
      selectedTicket.status !== "resolved" &&
      selectedTicket.status !== "cancelled" &&
      selectedTicket.status !== "archived";

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

  const handleDeleteCategory = useCallback(
    async (categoryId: string, replacementCategoryId?: string) => {
      try {
        const result = await deleteCategory(categoryId, { replacementCategoryId });
        for (const ticket of tickets) invalidateTicketSnapshot(ticket.id);
        setTicketDetails(new Map());
        ticketDetailsRef.current = new Map();
        await refreshTicketCollections();
        showToast({
          tone: "success",
          message: result.migratedTicketCount > 0
            ? `${result.migratedTicketCount} ticket${result.migratedTicketCount === 1 ? " foi migrado" : "s foram migrados"}; categoria excluída.`
            : "Categoria excluída definitivamente.",
        });
        return result;
      } catch (error) {
        showToast({
          tone: "warning",
          message:
            error instanceof Error
              ? error.message
              : "Não foi possível excluir a categoria.",
        });
        throw error;
      }
    },
    [invalidateTicketSnapshot, refreshTicketCollections, showToast, tickets],
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

  const handleGenerateDocumentation = useCallback(async (ticketId: string) => {
    setGeneratingDocumentationTicketId(ticketId);
    try {
      await queueTicketDocumentation(ticketId);
      showToast({ tone: "success", message: "Extração de conhecimento adicionada à fila." });
      navigateToView("documentation");
    } catch (error) {
      showToast({
        tone: "warning",
        message: error instanceof Error ? error.message : "Não foi possível extrair o conhecimento.",
      });
    } finally {
      setGeneratingDocumentationTicketId(null);
    }
  }, [navigateToView, showToast]);

  const openSettingsTab = useCallback((tab: SettingsTab) => {
    navigateToView("settings", { settingsTab: tab });
  }, [navigateToView]);

  const openNotificationTarget = useCallback((targetUrl: string) => {
    const target = new URL(targetUrl, window.location.origin);
    if (target.origin !== window.location.origin) return;
    const navigation = parseThreadmarkLocation(target.pathname, target.search);
    window.history.pushState({}, "", `${target.pathname}${target.search}`);
    applyLocationNavigation(navigation);
  }, [applyLocationNavigation]);

  const dismissNotificationPreview = useCallback(() => {
    setNotificationPreviewQueue((current) => current.slice(1));
  }, []);

  const openLiveNotification = useCallback(async (notification: NotificationDto) => {
    if (!notification.readAt) {
      try {
        const result = await updateNotificationRead(notification.id, true);
        setUnreadNotifications(result.unread);
      } catch {
        // A notificação permanece disponível na central mesmo se a leitura falhar.
      }
    }
    dismissNotificationPreview();
    if (notification.targetUrl) openNotificationTarget(notification.targetUrl);
    else navigateToView("notifications");
  }, [dismissNotificationPreview, navigateToView, openNotificationTarget]);

  const currentPage = pageContent[activeView];
  const threadmarkAiContext = useMemo(
    () => ({
      route: buildThreadmarkPath({
        view: activeView,
        ticketReference:
          activeView === "inbox" && selectedTicket
            ? String(selectedTicket.number)
            : null,
        settingsTab: settingsInitialTab,
      }),
      label: selectedTicket
        ? `Ticket #${selectedTicket.number} · ${selectedTicket.title}`
        : currentPage.title,
      ticketId: selectedTicket?.id ?? null,
      ticketNumber: selectedTicket?.number ?? null,
      groupId: selectedTicket?.group.id ?? null,
      groupName: selectedTicket?.group.subject ?? null,
    }),
    [activeView, currentPage.title, selectedTicket, settingsInitialTab],
  );
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
              onOpenCategoryCatalog={() => navigateToView("categories")}
              onOpenProductForwarding={openProductForwarding}
              onGenerateDocumentation={handleGenerateDocumentation}
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
              generatingDocumentation={generatingDocumentationTicketId === selectedTicket?.id}
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
            onDelete={handleDeleteCategory}
          />
        );
      case "documentation":
        return <DocumentationView />;
      case "automations":
        return <AutomationsView />;
      case "notifications":
        return (
          <NotificationsView
            onOpenTarget={openNotificationTarget}
            onUnreadChange={setUnreadNotifications}
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
    handleDeleteCategory,
    handleDeleteTicket,
    handleDetachTicketMessage,
    handleAttachCategory,
    handleDetachCategory,
    handleGenerateDocumentation,
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
    openManualTicketDialog,
    openNotificationTarget,
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
    generatingDocumentationTicketId,
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
        unreadNotifications={unreadNotifications}
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
      <main className="ml-0 flex h-dvh min-h-0 flex-col overflow-hidden transition-[margin] md:ml-[238px]">
        {activeView !== "settings" && activeView !== "inbox" ? (
          <PageHeader
            onOpenMenu={() => setSidebarOpen(true)}
            onOpenNotificationTarget={openNotificationTarget}
            onOpenNotifications={() => navigateToView("notifications")}
            onRefresh={() => void refreshAll()}
            onUnreadNotificationsChange={setUnreadNotifications}
            refreshing={refreshing}
            runtime={runtime}
            subtitle={currentPage.subtitle}
            title={currentPage.title}
            unreadNotifications={unreadNotifications}
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
      {notificationPreviewQueue[0] ? (
        <NotificationLivePreview
          key={notificationPreviewQueue[0].id}
          notification={notificationPreviewQueue[0]}
          onDismiss={dismissNotificationPreview}
          onOpen={(notification) => void openLiveNotification(notification)}
          pendingCount={Math.max(0, notificationPreviewQueue.length - 1)}
        />
      ) : null}
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
      <ThreadmarkAi context={threadmarkAiContext} />
      {roomSearchOpen ? (
        <SupportSearchOverlay
          onClose={() => setRoomSearchOpen(false)}
          onOpenTicket={(ticketId) => {
            setRoomSearchOpen(false);
            openTicket(ticketId);
          }}
          tickets={tickets}
        />
      ) : null}
    </div>
  );
}
