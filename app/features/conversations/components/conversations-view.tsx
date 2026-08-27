"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  attachConversationMessages,
  createConversationTicket,
  getConversationMessages,
  getConversations,
  getTriageAiSettings,
  ignoreConversationMessages,
  keepAllPendingMessagesAsContext,
  keepConversationMessagesAsContext,
  keepConversationPendingMessagesAsContext,
  restoreConversationMessages,
  setConversationSuggestionsMuted,
  triggerConversationAnalysis,
} from "@/app/lib/api";
import type {
  ConversationDetail,
  ConversationMessage,
  ConversationSummary,
  ConversationTriageBlock,
} from "@/app/lib/conversations";
import {
  isCurrentConversationRequest,
  isNearConversationBottom,
  scrollTopForPreservedAnchor,
} from "@/app/lib/conversation-scroll";
import { formatMessageTime, formatRelativeTime } from "@/app/lib/format";
import type { ClientSummary, TicketSummary } from "@/app/lib/types";
import type {
  ConversationSuggestionAnalysisDto,
  TriageAiSettingsDto,
} from "@/shared/contracts";
import {
  ConversationActionDialog,
  type CreateTicketDraft,
} from "./conversation-action-dialog";
import {
  ConversationDirectory,
  type ConversationFilter,
} from "./conversation-directory";
import {
  applyReactionUpdates,
  messageIsSelectable,
} from "./conversation-message";
import { ConversationChat } from "./conversation-chat";
import { ConversationSelectionCard } from "./conversation-selection-card";
import { ConversationAiCard } from "./conversation-ai-card";
import { ConversationTriagePanel } from "./conversation-triage-panel";

type DialogMode = "create" | "attach";
type DialogSnapshot = {
  mode: DialogMode;
  conversationId: string;
  messageIds: string[];
  draft: CreateTicketDraft;
  initialTicketId: string | null;
  tickets: TicketSummary[];
};
type ConversationViewportAnchor = {
  conversationId: string;
  generation: number;
  messageId: string;
  viewportOffset: number;
};
type ToastTone = "success" | "warning";

type ConversationsViewProps = {
  clients: ClientSummary[];
  tickets: TicketSummary[];
  refreshVersion: number;
  onOpenTicket: (ticketId: string) => void;
  onOpenAiSettings: () => void;
  onTicketsChanged: () => Promise<void>;
  onToast: (toast: { tone: ToastTone; message: string }) => void;
};

const CONVERSATION_PAGE_SIZE = 10;

const conversationMessageAnchorSelector = "[data-conversation-message-id]";

function captureConversationViewportAnchor(
  container: HTMLDivElement,
): Pick<ConversationViewportAnchor, "messageId" | "viewportOffset"> | null {
  const viewport = container.getBoundingClientRect();
  const messages = [
    ...container.querySelectorAll<HTMLElement>(conversationMessageAnchorSelector),
  ];
  const visible = messages.find((message) => {
    const bounds = message.getBoundingClientRect();
    return bounds.bottom > viewport.top && bounds.top < viewport.bottom;
  });
  const nearest = visible ?? messages.find(
    (message) => message.getBoundingClientRect().top >= viewport.top,
  ) ?? messages.at(-1);
  const messageId = nearest?.dataset.conversationMessageId;
  if (!nearest || !messageId) return null;
  return {
    messageId,
    viewportOffset: nearest.getBoundingClientRect().top - viewport.top,
  };
}

function restoreConversationViewportAnchor(
  container: HTMLDivElement,
  anchor: Pick<ConversationViewportAnchor, "messageId" | "viewportOffset">,
): boolean {
  const message = [
    ...container.querySelectorAll<HTMLElement>(conversationMessageAnchorSelector),
  ].find((candidate) =>
    candidate.dataset.conversationMessageId === anchor.messageId,
  );
  if (!message) return false;
  const viewportTop = container.getBoundingClientRect().top;
  const currentViewportOffset = message.getBoundingClientRect().top - viewportTop;
  container.scrollTop = scrollTopForPreservedAnchor({
    currentScrollTop: container.scrollTop,
    currentViewportOffset,
    preservedViewportOffset: anchor.viewportOffset,
  });
  return true;
}

function suggestionAnalysisCopy(
  analysis: ConversationSuggestionAnalysisDto,
): { title: string; description: string } {
  const pendingLabel = `${analysis.pendingMessageCount} ${
    analysis.pendingMessageCount === 1 ? "mensagem externa" : "mensagens externas"
  }`;
  if (analysis.state === "waiting_for_silence") {
    const schedule = analysis.nextAnalysisAt
      ? `${formatRelativeTime(analysis.nextAnalysisAt)} (${formatMessageTime(analysis.nextAnalysisAt)})`
      : "após a janela de silêncio";
    return {
      title: "Agrupando mensagens",
      description: `${pendingLabel} no contexto. A análise começa ${schedule}.`,
    };
  }
  if (analysis.state === "waiting_for_audio") {
    return {
      title: "Aguardando transcrição do áudio",
      description: `${pendingLabel}. A análise começa automaticamente quando o áudio estiver transcrito.`,
    };
  }
  if (analysis.state === "waiting_for_context") {
    return {
      title: "Aguardando mais contexto",
      description: `${pendingLabel}. A IA só tentará novamente quando chegar uma nova mensagem externa.`,
    };
  }
  if (analysis.state === "queued") {
    return {
      title: "Análise na fila",
      description: `${pendingLabel} agrupadas para a próxima execução da IA.`,
    };
  }
  if (analysis.state === "running") {
    return {
      title: "IA analisando o contexto",
      description: `${pendingLabel} estão sendo avaliadas como um único contexto.`,
    };
  }
  return {
    title: "Triagem em dia",
    description: "Não há novas mensagens aguardando análise.",
  };
}

function messageFallback(message: ConversationMessage): string {
  if (message.text?.trim()) return message.text.trim();
  if (message.attachments.length) {
    return `${message.attachments.length} ${message.attachments.length === 1 ? "anexo" : "anexos"}`;
  }
  return `Mensagem ${message.messageType}`;
}

function buildDraft(
  messages: ConversationMessage[],
  conversation: ConversationSummary,
  block?: ConversationTriageBlock | null,
): CreateTicketDraft {
  const excerpts = messages.map(messageFallback).filter(Boolean);
  const first = excerpts[0] ?? "Nova demanda";
  const title = first.length > 108 ? `${first.slice(0, 105).trimEnd()}…` : first;
  return {
    title: block?.title || title,
    summary: block?.summary || excerpts.join("\n\n").slice(0, 1600),
    clientId: conversation.client.isUnidentified ? null : conversation.client.id,
    priority: block?.suggestedPriority ?? "normal",
  };
}

export function ConversationsView({
  clients,
  tickets,
  refreshVersion,
  onOpenAiSettings,
  onOpenTicket,
  onTicketsChanged,
  onToast,
}: ConversationsViewProps) {
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const chatContentRef = useRef<HTMLDivElement>(null);
  const shouldFollowLatestRef = useRef(true);
  const pendingInitialScrollRef = useRef<string | null>(null);
  const conversationGenerationRef = useRef(0);
  const historyRequestRef = useRef(0);
  const historyViewportAnchorRef = useRef<ConversationViewportAnchor | null>(null);
  const selectionAnchorRef = useRef<string | null>(null);
  const selectedConversationRef = useRef<string | null>(null);
  const detailRequestRef = useRef(0);
  const listRequestRef = useRef(0);
  const conversationFilterKeyRef = useRef("");
  const loadedConversationCountRef = useRef(CONVERSATION_PAGE_SIZE);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [selectedMessageIds, setSelectedMessageIds] = useState<Set<string>>(() => new Set());
  const [filter, setFilter] = useState<ConversationFilter>("pending");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMoreConversations, setLoadingMoreConversations] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [loadingBlockId, setLoadingBlockId] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [conversationNextCursor, setConversationNextCursor] = useState<string | null>(null);
  const [hasMoreConversations, setHasMoreConversations] = useState(false);
  const [conversationTotal, setConversationTotal] = useState(0);
  const [pendingTotal, setPendingTotal] = useState(0);
  const [actionBusy, setActionBusy] = useState(false);
  const [keepingAllPending, setKeepingAllPending] = useState(false);
  const [dialogSnapshot, setDialogSnapshot] = useState<DialogSnapshot | null>(null);
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [triageAiSettings, setTriageAiSettings] =
    useState<TriageAiSettingsDto | null>(null);
  const [triageAiSettingsLoading, setTriageAiSettingsLoading] = useState(true);
  const [triggeringAnalysis, setTriggeringAnalysis] = useState(false);

  const scrollConversationToLatest = useCallback(() => {
    const container = chatScrollRef.current;
    if (!container) return;
    historyViewportAnchorRef.current = null;
    container.scrollTop = container.scrollHeight;
    shouldFollowLatestRef.current = true;
  }, []);

  const handleConversationScroll = useCallback(() => {
    const container = chatScrollRef.current;
    if (!container) return;
    shouldFollowLatestRef.current = isNearConversationBottom(container);
  }, []);

  const selectConversation = useCallback((conversationId: string | null) => {
    if (selectedConversationRef.current === conversationId) return;
    selectedConversationRef.current = conversationId;
    conversationGenerationRef.current += 1;
    historyRequestRef.current += 1;
    historyViewportAnchorRef.current = null;
    setSelectedConversationId(conversationId);
  }, []);

  const clearHistoryAnchorForScrollIntent = useCallback(() => {
    historyViewportAnchorRef.current = null;
    shouldFollowLatestRef.current = false;
  }, []);

  const clearHistoryAnchorForPointerIntent = useCallback(() => {
    historyViewportAnchorRef.current = null;
  }, []);

  const restoreActiveHistoryViewportAnchor = useCallback(() => {
    const anchor = historyViewportAnchorRef.current;
    const container = chatScrollRef.current;
    if (!anchor || !container) return false;
    if (!isCurrentConversationRequest(anchor, {
      conversationId: selectedConversationRef.current,
      generation: conversationGenerationRef.current,
    })) {
      historyViewportAnchorRef.current = null;
      return false;
    }
    if (!restoreConversationViewportAnchor(container, anchor)) {
      historyViewportAnchorRef.current = null;
      return false;
    }
    shouldFollowLatestRef.current = isNearConversationBottom(container);
    return true;
  }, []);

  const conversationFilters = useMemo(() => ({
    query: debouncedQuery,
    attention: filter === "pending" ? "pending" as const : "all" as const,
    scope:
      filter === "group"
        ? "group" as const
        : filter === "direct"
          ? "direct" as const
          : undefined,
  }), [debouncedQuery, filter]);
  const conversationFilterKey = JSON.stringify(conversationFilters);

  useEffect(() => {
    conversationFilterKeyRef.current = conversationFilterKey;
  }, [conversationFilterKey]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    let active = true;
    void getTriageAiSettings()
      .then((settings) => {
        if (active) setTriageAiSettings(settings);
      })
      .catch((nextError) => {
        if (!active) return;
        onToast({
          tone: "warning",
          message:
            nextError instanceof Error
              ? nextError.message
              : "Não foi possível carregar a configuração da triagem por IA.",
        });
      })
      .finally(() => {
        if (active) setTriageAiSettingsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [onToast]);

  const loadConversationList = useCallback(async (silent = false) => {
    const requestId = ++listRequestRef.current;
    const filterKey = conversationFilterKey;
    if (!silent) setLoading(true);
    try {
      const targetCount = silent
        ? Math.max(CONVERSATION_PAGE_SIZE, loadedConversationCountRef.current)
        : CONVERSATION_PAGE_SIZE;
      const items: ConversationSummary[] = [];
      let cursor: string | null = null;
      let response = await getConversations({
        ...conversationFilters,
        limit: CONVERSATION_PAGE_SIZE,
      });
      items.push(...response.items);
      while (response.hasMore && response.nextCursor && items.length < targetCount) {
        cursor = response.nextCursor;
        response = await getConversations({
          ...conversationFilters,
          cursor,
          limit: CONVERSATION_PAGE_SIZE,
        });
        items.push(...response.items);
      }
      if (
        listRequestRef.current !== requestId ||
        conversationFilterKeyRef.current !== filterKey
      ) return;
      setConversations(items);
      loadedConversationCountRef.current = Math.max(
        CONVERSATION_PAGE_SIZE,
        items.length,
      );
      setConversationTotal(response.total);
      setPendingTotal(response.pendingTotal);
      setConversationNextCursor(response.nextCursor);
      setHasMoreConversations(response.hasMore);
      const currentConversationId = selectedConversationRef.current;
      const nextConversationId =
        silent && currentConversationId
          ? currentConversationId
          : currentConversationId && items.some((item) => item.id === currentConversationId)
            ? currentConversationId
            : items.find((item) => item.pendingCount > 0)?.id ?? items[0]?.id ?? null;
      selectConversation(nextConversationId);
      setError(null);
    } catch (nextError) {
      if (
        listRequestRef.current !== requestId ||
        conversationFilterKeyRef.current !== filterKey
      ) return;
      setError(nextError instanceof Error ? nextError.message : "Não foi possível carregar as conversas.");
    } finally {
      if (!silent && listRequestRef.current === requestId) setLoading(false);
    }
  }, [conversationFilterKey, conversationFilters, selectConversation]);

  const loadMoreConversations = useCallback(async () => {
    if (!conversationNextCursor || loadingMoreConversations) return;
    const requestId = ++listRequestRef.current;
    const filterKey = conversationFilterKey;
    setLoadingMoreConversations(true);
    try {
      const response = await getConversations({
        ...conversationFilters,
        cursor: conversationNextCursor,
        limit: CONVERSATION_PAGE_SIZE,
      });
      if (
        listRequestRef.current !== requestId ||
        conversationFilterKeyRef.current !== filterKey
      ) return;
      setConversations((current) => {
        const merged = new Map(current.map((conversation) => [conversation.id, conversation]));
        for (const conversation of response.items) merged.set(conversation.id, conversation);
        const items = [...merged.values()];
        loadedConversationCountRef.current = Math.max(
          CONVERSATION_PAGE_SIZE,
          items.length,
        );
        return items;
      });
      setConversationTotal(response.total);
      setPendingTotal(response.pendingTotal);
      setConversationNextCursor(response.nextCursor);
      setHasMoreConversations(response.hasMore);
    } catch (nextError) {
      onToast({
        tone: "warning",
        message: nextError instanceof Error ? nextError.message : "Não foi possível carregar mais conversas.",
      });
    } finally {
      setLoadingMoreConversations(false);
    }
  }, [conversationFilterKey, conversationFilters, conversationNextCursor, loadingMoreConversations, onToast]);

  const loadConversationDetail = useCallback(async (conversationId: string, silent = false) => {
    const requestId = ++detailRequestRef.current;
    if (!silent) setDetailLoading(true);
    try {
      const response = await getConversationMessages(conversationId);
      if (
        selectedConversationRef.current !== conversationId ||
        detailRequestRef.current !== requestId
      ) return;
      setDetail({
        conversation: response.conversation,
        messages: response.items.toSorted((left, right) => left.occurredAt.localeCompare(right.occurredAt)),
        blocks: response.suggestedBlocks,
        suggestionAnalysis: response.suggestionAnalysis,
      });
      setNextCursor(response.nextCursor);
      setHasMore(response.hasMore);
      setConversations((current) => current.map((item) =>
        item.id === response.conversation.id ? response.conversation : item,
      ));
      setError(null);
    } catch (nextError) {
      if (
        selectedConversationRef.current !== conversationId ||
        detailRequestRef.current !== requestId
      ) return;
      setDetail(null);
      setError(nextError instanceof Error ? nextError.message : "Não foi possível abrir a conversa.");
    } finally {
      if (
        !silent &&
        selectedConversationRef.current === conversationId &&
        detailRequestRef.current === requestId
      ) setDetailLoading(false);
    }
  }, []);

  const loadEarlierMessages = useCallback(async () => {
    if (!selectedConversationId || !nextCursor || loadingEarlier) return;
    const requestIdentity = {
      conversationId: selectedConversationId,
      generation: conversationGenerationRef.current,
    };
    const requestId = ++historyRequestRef.current;
    const requestIsCurrent = () =>
      historyRequestRef.current === requestId &&
      isCurrentConversationRequest(requestIdentity, {
        conversationId: selectedConversationRef.current,
        generation: conversationGenerationRef.current,
      });
    setLoadingEarlier(true);
    try {
      const response = await getConversationMessages(selectedConversationId, {
        before: nextCursor,
      });
      if (!requestIsCurrent()) return;

      const scrollContainer = chatScrollRef.current;
      const capturedAnchor = scrollContainer
        ? captureConversationViewportAnchor(scrollContainer)
        : null;
      const activeAnchor: ConversationViewportAnchor | null = capturedAnchor
        ? {
            ...capturedAnchor,
            conversationId: selectedConversationId,
            generation: requestIdentity.generation,
          }
        : null;
      historyViewportAnchorRef.current = activeAnchor;
      shouldFollowLatestRef.current = false;

      setDetail((current) => {
        if (
          !requestIsCurrent() ||
          !current ||
          current.conversation.id !== selectedConversationId
        ) return current;
        const merged = new Map(current.messages.map((message) => [message.id, message]));
        for (const message of response.items) merged.set(message.id, message);
        return {
          ...current,
          conversation: response.conversation,
          suggestionAnalysis: response.suggestionAnalysis,
          messages: applyReactionUpdates(
            [...merged.values()].toSorted((left, right) =>
              left.occurredAt.localeCompare(right.occurredAt),
            ),
            response.reactionUpdates,
          ),
        };
      });
      setNextCursor(response.nextCursor);
      setHasMore(response.hasMore);
      window.requestAnimationFrame(() => {
        if (
          !requestIsCurrent() ||
          !activeAnchor ||
          historyViewportAnchorRef.current !== activeAnchor
        ) return;
        const current = chatScrollRef.current;
        if (!current) return;
        restoreConversationViewportAnchor(current, activeAnchor);
        shouldFollowLatestRef.current = isNearConversationBottom(current);
      });
    } catch (nextError) {
      if (!requestIsCurrent()) return;
      onToast({
        tone: "warning",
        message: nextError instanceof Error ? nextError.message : "Não foi possível carregar mensagens anteriores.",
      });
    } finally {
      if (requestIsCurrent()) setLoadingEarlier(false);
    }
  }, [loadingEarlier, nextCursor, onToast, selectedConversationId]);

  const selectSuggestedBlock = useCallback(async (block: ConversationTriageBlock) => {
    if (!detail || selectedConversationRef.current !== detail.conversation.id) return;
    const targetIds = new Set(block.messageIds);
    const loaded = new Map(detail.messages.map((message) => [message.id, message]));
    let cursor = nextCursor;
    let more = hasMore;
    let pages = 0;

    setLoadingBlockId(block.id);
    try {
      while (
        [...targetIds].some((id) => !loaded.has(id)) &&
        more &&
        cursor &&
        pages < 50
      ) {
        const response = await getConversationMessages(detail.conversation.id, {
          before: cursor,
        });
        if (selectedConversationRef.current !== detail.conversation.id) return;
        for (const message of response.items) loaded.set(message.id, message);
        cursor = response.nextCursor;
        more = response.hasMore;
        pages += 1;
      }

      const missing = [...targetIds].filter((id) => !loaded.has(id));
      if (missing.length) {
        onToast({
          tone: "warning",
          message: "Não foi possível carregar todo o bloco sugerido. Tente carregar mais mensagens anteriores.",
        });
        return;
      }

      setDetail((current) => {
        if (!current || current.conversation.id !== detail.conversation.id) return current;
        const merged = new Map(current.messages.map((message) => [message.id, message]));
        for (const message of loaded.values()) merged.set(message.id, message);
        return {
          ...current,
          messages: [...merged.values()].toSorted((left, right) =>
            left.occurredAt.localeCompare(right.occurredAt),
          ),
        };
      });
      setNextCursor(cursor);
      setHasMore(more);
      setSelectedMessageIds(new Set(block.messageIds));
      selectionAnchorRef.current = block.messageIds.at(-1) ?? null;
      historyViewportAnchorRef.current = null;
      shouldFollowLatestRef.current = false;
      window.requestAnimationFrame(() => {
        document
          .getElementById(`conversation-message-${block.messageIds[0] ?? ""}`)
          ?.scrollIntoView({ block: "center", behavior: "smooth" });
      });
    } catch (nextError) {
      onToast({
        tone: "warning",
        message: nextError instanceof Error
          ? nextError.message
          : "Não foi possível carregar as mensagens do bloco.",
      });
    } finally {
      setLoadingBlockId(null);
    }
  }, [detail, hasMore, nextCursor, onToast]);

  const refreshOpenConversation = useCallback(async (conversationId: string) => {
    const requestId = ++detailRequestRef.current;
    try {
      const response = await getConversationMessages(conversationId);
      if (
        selectedConversationRef.current !== conversationId ||
        detailRequestRef.current !== requestId
      ) return;
      setDetail((current) => {
        if (!current || current.conversation.id !== conversationId) return current;
        const merged = new Map(current.messages.map((message) => [message.id, message]));
        for (const message of response.items) merged.set(message.id, message);
        return {
          conversation: response.conversation,
          messages: applyReactionUpdates(
            [...merged.values()].toSorted((left, right) =>
              left.occurredAt.localeCompare(right.occurredAt),
            ),
            response.reactionUpdates,
          ),
          blocks: response.suggestedBlocks,
          suggestionAnalysis: response.suggestionAnalysis,
        };
      });
      setConversations((current) => current.map((conversation) =>
        conversation.id === response.conversation.id
          ? response.conversation
          : conversation,
      ));
    } catch {
      // A próxima atualização ou ação explícita tenta novamente sem descartar o histórico carregado.
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadConversationList(), 0);
    return () => window.clearTimeout(timer);
  }, [loadConversationList, refreshVersion]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!selectedConversationId) {
        detailRequestRef.current += 1;
        pendingInitialScrollRef.current = null;
        historyViewportAnchorRef.current = null;
        setLoadingEarlier(false);
        setDetail(null);
        setDetailLoading(false);
        return;
      }
      pendingInitialScrollRef.current = selectedConversationId;
      historyViewportAnchorRef.current = null;
      shouldFollowLatestRef.current = true;
      setLoadingEarlier(false);
      setDetail(null);
      setSelectedMessageIds(new Set());
      selectionAnchorRef.current = null;
      setMobilePanelOpen(false);
      setNextCursor(null);
      setHasMore(false);
      void loadConversationDetail(selectedConversationId);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadConversationDetail, selectedConversationId]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void loadConversationList(true);
      if (selectedConversationId) void refreshOpenConversation(selectedConversationId);
    }, 15_000);
    return () => window.clearInterval(interval);
  }, [loadConversationList, refreshOpenConversation, selectedConversationId]);

  const activeSuggestionAnalysisState =
    detail?.conversation.id === selectedConversationId
      ? detail.suggestionAnalysis.state
      : "idle";

  useEffect(() => {
    if (
      !selectedConversationId ||
      (activeSuggestionAnalysisState !== "queued" &&
        activeSuggestionAnalysisState !== "running")
    ) return;
    const interval = window.setInterval(() => {
      void refreshOpenConversation(selectedConversationId);
    }, 3_000);
    return () => window.clearInterval(interval);
  }, [activeSuggestionAnalysisState, refreshOpenConversation, selectedConversationId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const conversationId = selectedConversationRef.current;
      if (conversationId) void refreshOpenConversation(conversationId);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refreshOpenConversation, refreshVersion]);

  const detailConversationId = detail?.conversation.id ?? null;
  const latestMessageId = detail?.messages.at(-1)?.id ?? null;

  useLayoutEffect(() => {
    if (
      detailLoading ||
      !detailConversationId ||
      detailConversationId !== selectedConversationId ||
      historyViewportAnchorRef.current
    ) return;

    const isOpeningConversation =
      pendingInitialScrollRef.current === detailConversationId;
    if (!isOpeningConversation && !shouldFollowLatestRef.current) return;

    if (isOpeningConversation) {
      pendingInitialScrollRef.current = null;
      shouldFollowLatestRef.current = true;
    }
    const conversationId = detailConversationId;
    scrollConversationToLatest();
    const frame = window.requestAnimationFrame(() => {
      if (
        selectedConversationRef.current !== conversationId ||
        historyViewportAnchorRef.current ||
        !shouldFollowLatestRef.current
      ) return;
      scrollConversationToLatest();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    detailConversationId,
    detailLoading,
    latestMessageId,
    scrollConversationToLatest,
    selectedConversationId,
  ]);

  useEffect(() => {
    const content = chatContentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;

    let frame: number | null = null;
    const observer = new ResizeObserver(() => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = null;
        if (restoreActiveHistoryViewportAnchor()) return;
        if (!shouldFollowLatestRef.current) return;
        scrollConversationToLatest();
      });
    });
    observer.observe(content);
    return () => {
      observer.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [
    detailConversationId,
    restoreActiveHistoryViewportAnchor,
    scrollConversationToLatest,
  ]);

  const filteredConversations = conversations;

  const selectedMessages = useMemo(() => {
    if (!detail) return [];
    return detail.messages.filter((message) => selectedMessageIds.has(message.id));
  }, [detail, selectedMessageIds]);
  const hasExternalSelection = selectedMessages.some((message) => !message.sender.isStaff);
  const hasTicketedSelection = selectedMessages.some(
    (message) => message.triage.state === "ticketed",
  );

  const canRestoreSelection = selectedMessages.length > 0 && selectedMessages.every(
    (message) => message.triage.state === "ignored" || message.triage.state === "context",
  );

  const toggleMessage = useCallback((messageId: string, shiftKey: boolean) => {
    if (!detail || loadingBlockId || actionBusy) return;
    const selectableIds = detail.messages.filter(messageIsSelectable).map((message) => message.id);
    const anchorId = selectionAnchorRef.current;
    setSelectedMessageIds((current) => {
      const next = new Set(current);
      if (shiftKey && anchorId) {
        const start = selectableIds.indexOf(anchorId);
        const end = selectableIds.indexOf(messageId);
        if (start >= 0 && end >= 0) {
          const [from, to] = start <= end ? [start, end] : [end, start];
          for (const id of selectableIds.slice(from, to + 1)) next.add(id);
          return next;
        }
      }
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      return next;
    });
    selectionAnchorRef.current = messageId;
  }, [actionBusy, detail, loadingBlockId]);

  const openActionDialog = useCallback((mode: DialogMode) => {
    if (!detail || loadingBlockId || actionBusy || !selectedMessageIds.size) return;
    const messageIds = [...selectedMessageIds];
    const messages = detail.messages.filter((message) => selectedMessageIds.has(message.id));
    const block = detail.blocks.find((item) =>
      item.messageIds.length === selectedMessageIds.size &&
      item.messageIds.every((id) => selectedMessageIds.has(id)),
    ) ?? null;
    setDialogSnapshot({
      mode,
      conversationId: detail.conversation.id,
      messageIds,
      draft: buildDraft(messages, detail.conversation, block),
      initialTicketId:
        block?.suggestedAction === "attach" ? block.suggestedTicketId : null,
      tickets: tickets.filter((ticket) => ticket.group.id === detail.conversation.id),
    });
  }, [actionBusy, detail, loadingBlockId, selectedMessageIds, tickets]);

  const refreshAfterAction = useCallback(async () => {
    if (!selectedConversationId) return;
    await Promise.all([
      loadConversationList(true),
      refreshOpenConversation(selectedConversationId),
      onTicketsChanged(),
    ]);
    setSelectedMessageIds(new Set());
    selectionAnchorRef.current = null;
  }, [loadConversationList, onTicketsChanged, refreshOpenConversation, selectedConversationId]);

  const runBatchAction = useCallback(async (
    action: "context" | "restore",
  ) => {
    if (!selectedConversationId || !selectedMessageIds.size || loadingBlockId) return;
    if (
      action === "context" &&
      selectedMessages.some((message) => message.triage.state === "ticketed")
    ) return;
    if (
      action === "restore" &&
      !selectedMessages.every(
        (message) => message.triage.state === "ignored" || message.triage.state === "context",
      )
    ) return;
    setActionBusy(true);
    try {
      const input = {
        conversationId: selectedConversationId,
        messageIds: [...selectedMessageIds],
        clientRequestId: crypto.randomUUID(),
      };
      if (action === "context") await keepConversationMessagesAsContext(input);
      if (action === "restore") await restoreConversationMessages(input);
      await refreshAfterAction();
      onToast({
        tone: "success",
        message:
          action === "context"
            ? "Mensagens mantidas como contexto da conversa."
            : "Mensagens restauradas para a fila de triagem.",
      });
    } catch (nextError) {
      onToast({ tone: "warning", message: nextError instanceof Error ? nextError.message : "A ação não pôde ser concluída." });
    } finally {
      setActionBusy(false);
    }
  }, [loadingBlockId, onToast, refreshAfterAction, selectedConversationId, selectedMessageIds, selectedMessages]);

  const keepAllPendingAsContext = useCallback(async () => {
    if (!pendingTotal || keepingAllPending || actionBusy || loadingBlockId) return;
    setKeepingAllPending(true);
    setActionBusy(true);
    try {
      const result = await keepAllPendingMessagesAsContext();
      await Promise.all([
        loadConversationList(true),
        selectedConversationId
          ? refreshOpenConversation(selectedConversationId)
          : Promise.resolve(),
      ]);
      setSelectedMessageIds(new Set());
      selectionAnchorRef.current = null;
      onToast({
        tone: "success",
        message: result.contextualizedMessageCount === 1
          ? "1 mensagem saiu das pendências e foi mantida como contexto."
          : `${result.contextualizedMessageCount} mensagens saíram das pendências e foram mantidas como contexto.`,
      });
    } catch (nextError) {
      onToast({
        tone: "warning",
        message: nextError instanceof Error
          ? nextError.message
          : "Não foi possível manter as pendências como contexto.",
      });
    } finally {
      setKeepingAllPending(false);
      setActionBusy(false);
    }
  }, [actionBusy, keepingAllPending, loadConversationList, loadingBlockId, onToast, pendingTotal, refreshOpenConversation, selectedConversationId]);

  const keepCurrentConversationPendingAsContext = useCallback(async () => {
    if (
      !selectedConversationId ||
      !detail?.conversation.pendingCount ||
      actionBusy ||
      loadingBlockId
    ) return;
    setActionBusy(true);
    try {
      const result = await keepConversationPendingMessagesAsContext(
        selectedConversationId,
      );
      await Promise.all([
        loadConversationList(true),
        refreshOpenConversation(selectedConversationId),
      ]);
      setSelectedMessageIds(new Set());
      selectionAnchorRef.current = null;
      onToast({
        tone: "success",
        message: result.contextualizedMessageCount === 1
          ? "1 mensagem desta conversa foi mantida como contexto."
          : `${result.contextualizedMessageCount} mensagens desta conversa foram mantidas como contexto.`,
      });
    } catch (nextError) {
      onToast({
        tone: "warning",
        message: nextError instanceof Error
          ? nextError.message
          : "Não foi possível manter as pendências desta conversa como contexto.",
      });
    } finally {
      setActionBusy(false);
    }
  }, [actionBusy, detail?.conversation.pendingCount, loadConversationList, loadingBlockId, onToast, refreshOpenConversation, selectedConversationId]);

  const ignoreSuggestedBlock = useCallback(async (
    block: ConversationTriageBlock,
  ) => {
    if (!selectedConversationId || actionBusy || loadingBlockId) return;
    setLoadingBlockId(block.id);
    setActionBusy(true);
    try {
      await ignoreConversationMessages({
        conversationId: selectedConversationId,
        messageIds: block.messageIds,
        clientRequestId: crypto.randomUUID(),
        reason: "Sugestão descartada pelo operador",
      });
      await refreshAfterAction();
      onToast({
        tone: "success",
        message: "Sugestão ignorada. As mensagens continuam salvas no histórico.",
      });
    } catch (nextError) {
      onToast({
        tone: "warning",
        message: nextError instanceof Error
          ? nextError.message
          : "Não foi possível ignorar esta sugestão.",
      });
    } finally {
      setActionBusy(false);
      setLoadingBlockId(null);
    }
  }, [actionBusy, loadingBlockId, onToast, refreshAfterAction, selectedConversationId]);

  const toggleConversationSuggestions = useCallback(async () => {
    if (!detail || actionBusy || loadingBlockId) return;
    const conversationId = detail.conversation.id;
    const muted = !detail.conversation.suggestionsMuted;
    setActionBusy(true);
    try {
      const result = await setConversationSuggestionsMuted(conversationId, muted);
      setDetail((current) => current?.conversation.id === conversationId
        ? {
            ...current,
            conversation: result.conversation,
            blocks: muted ? [] : current.blocks,
          }
        : current);
      setConversations((current) => current.map((conversation) =>
        conversation.id === conversationId ? result.conversation : conversation,
      ));
      setSelectedMessageIds(new Set());
      selectionAnchorRef.current = null;
      await Promise.all([
        loadConversationList(true),
        refreshOpenConversation(conversationId),
      ]);
      onToast({
        tone: "success",
        message: muted
          ? result.contextualizedMessageCount > 0
            ? `Sugestões pausadas. ${result.contextualizedMessageCount} mensagem(ns) pendente(s) foram mantidas como contexto; o histórico continua sendo salvo.`
            : "Sugestões pausadas. O histórico e os anexos continuam sendo salvos normalmente."
          : "Sugestões reativadas. Somente novas mensagens voltarão a entrar na triagem automática.",
      });
    } catch (nextError) {
      onToast({
        tone: "warning",
        message: nextError instanceof Error
          ? nextError.message
          : "Não foi possível atualizar as sugestões desta conversa.",
      });
    } finally {
      setActionBusy(false);
    }
  }, [actionBusy, detail, loadConversationList, loadingBlockId, onToast, refreshOpenConversation]);

  const analyzeConversationNow = useCallback(async () => {
    if (!detail || triggeringAnalysis || actionBusy || loadingBlockId) return;
    const conversationId = detail.conversation.id;
    setTriggeringAnalysis(true);
    try {
      const result = await triggerConversationAnalysis(conversationId);
      setDetail((current) => current?.conversation.id === conversationId
        ? { ...current, suggestionAnalysis: result.analysis }
        : current);
      await refreshOpenConversation(conversationId);
      onToast({
        tone: "success",
        message: result.accepted
          ? "Análise antecipada. A IA vai revisar o contexto agrupado sem criar ticket automaticamente."
          : "A conversa já está na fila de análise.",
      });
    } catch (nextError) {
      onToast({
        tone: "warning",
        message: nextError instanceof Error
          ? nextError.message
          : "Não foi possível antecipar a análise desta conversa.",
      });
    } finally {
      setTriggeringAnalysis(false);
    }
  }, [actionBusy, detail, loadingBlockId, onToast, refreshOpenConversation, triggeringAnalysis]);

  const suggestionAnalysis =
    detail?.conversation.id === selectedConversationId
      ? detail.suggestionAnalysis
      : null;
  const suggestionAnalysisStatus = suggestionAnalysis
    ? suggestionAnalysisCopy(suggestionAnalysis)
    : null;
  const canTriggerSuggestionAnalysis = Boolean(
    triageAiSettings?.enabled &&
      suggestionAnalysis &&
      suggestionAnalysis.pendingMessageCount > 0 &&
      (suggestionAnalysis.state === "waiting_for_silence" ||
        suggestionAnalysis.state === "waiting_for_context"),
  );

  return (
    <div className="grid h-full min-h-0 grid-cols-[310px_minmax(360px,1fr)_292px] bg-card max-[1279px]:grid-cols-[292px_minmax(340px,1fr)_280px] max-[1050px]:grid-cols-[275px_minmax(310px,1fr)_265px] min-[761px]:max-[900px]:grid-cols-[260px_minmax(0,1fr)] max-[760px]:block max-[760px]:overflow-hidden">
      <ConversationDirectory
        keepingAllPending={keepingAllPending}
        conversationTotal={conversationTotal}
        conversations={conversations}
        error={error}
        filter={filter}
        filteredConversations={filteredConversations}
        hasMore={hasMoreConversations}
        loading={loading}
        loadingMore={loadingMoreConversations}
        onFilterChange={setFilter}
        onKeepAllPendingAsContext={() => void keepAllPendingAsContext()}
        onLoadMore={() => void loadMoreConversations()}
        onQueryChange={setQuery}
        onRetry={() => void loadConversationList()}
        onSelect={(conversationId) => selectConversation(conversationId)}
        query={query}
        pendingTotal={pendingTotal}
        selectedConversationId={selectedConversationId}
      />

      <ConversationChat
        chatContentRef={chatContentRef}
        chatScrollRef={chatScrollRef}
        detail={detail}
        detailLoading={detailLoading}
        hasExternalSelection={hasExternalSelection}
        hasMore={hasMore}
        hasTicketedSelection={hasTicketedSelection}
        loadingEarlier={loadingEarlier}
        onAttachTicket={() => openActionDialog("attach")}
        onBack={() => selectConversation(null)}
        onClearSelection={() => setSelectedMessageIds(new Set())}
        onCreateTicket={() => openActionDialog("create")}
        onKeyDown={clearHistoryAnchorForScrollIntent}
        onLoadEarlier={() => void loadEarlierMessages()}
        onOpenTicket={onOpenTicket}
        onOpenTriage={() => setMobilePanelOpen(true)}
        onPointerDown={clearHistoryAnchorForPointerIntent}
        onScroll={handleConversationScroll}
        onToggleMessage={toggleMessage}
        onTouchStart={clearHistoryAnchorForScrollIntent}
        onWheel={clearHistoryAnchorForScrollIntent}
        selectedConversationId={selectedConversationId}
        selectedMessageIds={selectedMessageIds}
        selectionLocked={Boolean(loadingBlockId) || actionBusy}
      />

      <ConversationTriagePanel
        busy={actionBusy || Boolean(loadingBlockId)}
        conversation={
          detail?.conversation.id === selectedConversationId
            ? detail.conversation
            : null
        }
        error={error}
        mobileOpen={mobilePanelOpen}
        onClose={() => setMobilePanelOpen(false)}
        onOpenTicket={onOpenTicket}
        onKeepPendingAsContext={() => void keepCurrentConversationPendingAsContext()}
        onToggleSuggestions={() => void toggleConversationSuggestions()}
        ticketRefreshVersion={refreshVersion}
      >
        <ConversationSelectionCard
          busy={actionBusy || Boolean(loadingBlockId)}
          canRestoreSelection={canRestoreSelection}
          hasExternalSelection={hasExternalSelection}
          hasTicketedSelection={hasTicketedSelection}
          onAttach={() => openActionDialog("attach")}
          onClear={() => setSelectedMessageIds(new Set())}
          onCreate={() => openActionDialog("create")}
          onKeepContext={() => void runBatchAction("context")}
          onRestore={() => void runBatchAction("restore")}
          selectedCount={selectedMessageIds.size}
        />

        <ConversationAiCard
          actionBusy={actionBusy}
          blocks={detail?.blocks ?? []}
          busy={actionBusy || Boolean(loadingBlockId)}
          canTriggerAnalysis={canTriggerSuggestionAnalysis}
          loadingBlockId={loadingBlockId}
          onAnalyzeNow={() => void analyzeConversationNow()}
          onIgnoreBlock={(block) => void ignoreSuggestedBlock(block)}
          onOpenSettings={onOpenAiSettings}
          onSelectBlock={(block) => void selectSuggestedBlock(block)}
          selectedMessageIds={selectedMessageIds}
          settings={triageAiSettings}
          settingsLoading={triageAiSettingsLoading}
          suggestionAnalysis={suggestionAnalysis}
          suggestionStatus={suggestionAnalysisStatus}
          suggestionsMuted={Boolean(detail?.conversation.suggestionsMuted)}
          tickets={tickets}
          triggeringAnalysis={triggeringAnalysis}
        />
      </ConversationTriagePanel>

      {dialogSnapshot ? (
        <ConversationActionDialog
          busy={actionBusy}
          clients={clients}
          initialDraft={dialogSnapshot.draft}
          initialTicketId={dialogSnapshot.initialTicketId}
          messageCount={dialogSnapshot.messageIds.length}
          mode={dialogSnapshot.mode}
          onAttach={(ticketId) => {
            setActionBusy(true);
            void attachConversationMessages({
              conversationId: dialogSnapshot.conversationId,
              messageIds: dialogSnapshot.messageIds,
              ticketId,
              clientRequestId: crypto.randomUUID(),
            }).then(async () => {
              setDialogSnapshot(null);
              await refreshAfterAction();
              onToast({ tone: "success", message: "Mensagens anexadas ao ticket e contexto atualizado." });
            }).catch((nextError) => {
              onToast({ tone: "warning", message: nextError instanceof Error ? nextError.message : "Não foi possível anexar as mensagens." });
            }).finally(() => setActionBusy(false));
          }}
          onCancel={() => setDialogSnapshot(null)}
          onCreate={(draft) => {
            setActionBusy(true);
            void createConversationTicket({
              conversationId: dialogSnapshot.conversationId,
              messageIds: dialogSnapshot.messageIds,
              title: draft.title.trim(),
              summary: draft.summary.trim(),
              clientId: draft.clientId,
              priority: draft.priority,
              clientRequestId: crypto.randomUUID(),
            }).then(async (response) => {
              setDialogSnapshot(null);
              await refreshAfterAction();
              onToast({ tone: "success", message: response.ticket?.number ? `Ticket #${response.ticket.number} criado e enviado para investigação.` : "Ticket criado e enviado para investigação." });
            }).catch((nextError) => {
              onToast({ tone: "warning", message: nextError instanceof Error ? nextError.message : "Não foi possível criar o ticket." });
            }).finally(() => setActionBusy(false));
          }}
          tickets={dialogSnapshot.tickets}
        />
      ) : null}
    </div>
  );
}
