import {
  ArrowLeft,
  BookOpenText,
  Bug,
  CheckCircle2,
  LoaderCircle,
  MoreHorizontal,
  Paperclip,
  Pencil,
  RefreshCw,
  ShieldCheck,
  Tag,
  Trash2,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  formatMessageTime,
  getRequesterPresentation,
  statusLabels,
} from "@/app/lib/format";
import type {
  TicketCategoryCatalog,
  CategoryFacetType,
  TicketAssignee,
  TicketDetail as TicketDetailType,
  TicketStatus,
} from "@/app/lib/types";
import {
  type UpdateTicketMetadataInput,
} from "@/shared/contracts.js";
import { PriorityPill, StatusPill } from "@/app/components/shared/status-pill";
import { TicketDeleteDialog } from "./ticket-delete-dialog";
import { TicketMetadataEditor } from "./ticket-metadata-editor";
import { EmptyState, LoadingState } from "@/app/components/shared/ui-states";
import { Button } from "@/app/components/ui/button";
import { NativeSelect } from "@/app/components/ui/native-select";
import { TicketConversation } from "./ticket-conversation";
import {
  TicketNoteComposer,
  type TicketNoteMutation,
} from "./ticket-notes";
import { CategoryPanel } from "./ticket-category-panel";
import { ContextPanel } from "./ticket-context-panel";
import { ProductForwardingPanel } from "./ticket-product-panel";
import { InvestigationRoomLauncher } from "./investigation-room-launcher";
import { TicketResolutionSummary } from "./ticket-resolution-summary";
import { TicketAssignmentPanel } from "./ticket-assignment-panel";

const mutableStatuses: TicketStatus[] = [
  "new",
  "triage",
  "in_progress",
  "waiting_customer",
  "blocked",
  "resolved",
];

type TicketDetailProps = {
  ticket: TicketDetailType | null;
  loading: boolean;
  updatingStatus: boolean;
  updatingMetadata: boolean;
  updatingAssignee: boolean;
  addingNote: boolean;
  ticketNoteMutation: TicketNoteMutation | null;
  detachingMessageId: string | null;
  canManageNotes: boolean;
  canEditTicket: boolean;
  assignees: TicketAssignee[];
  currentUserId: string | null;
  deleting: boolean;
  onStatusChange: (status: TicketStatus) => void;
  onOpenInvestigationRoom: () => void;
  onRefresh: () => void;
  onDelete: (ticketId: string) => Promise<boolean>;
  onBackToKanban: () => void;
  onAddNote: (
    ticketId: string,
    body: string,
    clientNoteId: string,
  ) => Promise<boolean>;
  onUpdateNote: (
    ticketId: string,
    noteId: string,
    body: string,
    expectedUpdatedAt: string,
  ) => Promise<boolean>;
  onDeleteNote: (ticketId: string, noteId: string) => Promise<boolean>;
  onDetachMessage: (ticketId: string, messageId: string) => Promise<boolean>;
  onAttachCategory?: (ticketId: string, categoryId: string) => Promise<boolean>;
  onDetachCategory?: (ticketId: string, categoryId: string) => Promise<boolean>;
  onCreateCategory?: (input: {
    facet: CategoryFacetType;
    label: string;
  }) => Promise<TicketCategoryCatalog>;
  categoryCatalog: TicketCategoryCatalog[];
  categoryMutationTicketId: string | null;
  canManageCategories: boolean;
  onOpenCategoryCatalog: () => void;
  onOpenProductForwarding: () => void;
  onUpdateMetadata: (
    ticketId: string,
    input: UpdateTicketMetadataInput,
  ) => Promise<boolean>;
  onUpdateAssignee: (
    ticketId: string,
    assigneeId: string | null,
  ) => Promise<boolean>;
  generatingDocumentation?: boolean;
  onGenerateDocumentation?: (ticketId: string) => void;
};

export function TicketDetail({
  ticket,
  loading,
  updatingStatus,
  updatingMetadata,
  updatingAssignee,
  addingNote,
  ticketNoteMutation,
  detachingMessageId,
  canManageNotes,
  canEditTicket,
  assignees,
  currentUserId,
  deleting,
  onStatusChange,
  onOpenInvestigationRoom,
  onRefresh,
  onDelete,
  onBackToKanban,
  onAddNote,
  onUpdateNote,
  onDeleteNote,
  onDetachMessage,
  onOpenProductForwarding,
  onUpdateMetadata,
  onUpdateAssignee,
  onAttachCategory,
  onDetachCategory,
  onCreateCategory,
  categoryCatalog,
  categoryMutationTicketId,
  canManageCategories,
  onOpenCategoryCatalog,
  generatingDocumentation,
  onGenerateDocumentation,
}: TicketDetailProps) {
  const [metadataEditorOpen, setMetadataEditorOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const conversationScrollRef = useRef<HTMLDivElement>(null);
  const categorySectionRef = useRef<HTMLElement>(null);
  const noteComposerRef = useRef<HTMLTextAreaElement>(null);
  const followLatestRef = useRef(true);
  const previousTicketIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!moreMenuOpen) return;

    function closeMenu(event: MouseEvent) {
      if (
        event.target instanceof Node &&
        !moreMenuRef.current?.contains(event.target)
      ) {
        setMoreMenuOpen(false);
      }
    }

    function handleEscape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") setMoreMenuOpen(false);
    }

    document.addEventListener("mousedown", closeMenu);
    window.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", closeMenu);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [moreMenuOpen]);
  const timelineSummary = useMemo(() => {
    if (!ticket) return "";
    const customerMessages = ticket.timeline.filter(
      (item) => item.type === "message" && !item.sender.isStaff,
    ).length;
    return `${ticket.messageCount} ${ticket.messageCount === 1 ? "mensagem" : "mensagens"} · ${customerMessages} do solicitante`;
  }, [ticket]);
  const activeTicketId = ticket?.id ?? null;
  const latestTimelineId = ticket?.timeline.at(-1)?.id ?? null;
  const timelineMediaSignature = useMemo(
    () =>
      ticket?.timeline
        .map((item) =>
          item.type === "message"
            ? item.attachments
                .map(
                  (attachment) =>
                    `${attachment.id}:${attachment.available ? "1" : "0"}:${attachment.url ?? ""}`,
                )
                .join(",")
            : "",
        )
        .join("|") ?? "",
    [ticket?.timeline],
  );
  const resolutionSignature = useMemo(() => {
    if (!ticket) return "";
    return [
      ticket.resolution?.summary ?? "",
      ticket.resolution?.validatedAt ?? "",
    ].join("\u001f");
  }, [ticket]);

  useEffect(() => {
    if (!activeTicketId) return;
    const scroll = conversationScrollRef.current;
    if (!scroll) return;
    if (previousTicketIdRef.current !== activeTicketId) {
      previousTicketIdRef.current = activeTicketId;
      followLatestRef.current = true;
    }
    if (!followLatestRef.current) return;

    const scrollToLatest = () => {
      if (!followLatestRef.current) return;
      scroll.scrollTop = scroll.scrollHeight;
    };
    const frame = window.requestAnimationFrame(scrollToLatest);
    let mediaFrame: number | null = null;
    const pendingImages = Array.from(scroll.querySelectorAll("img")).filter(
      (image) => !image.complete,
    );
    const handleImageSettled = () => {
      if (mediaFrame !== null) window.cancelAnimationFrame(mediaFrame);
      mediaFrame = window.requestAnimationFrame(scrollToLatest);
    };
    for (const image of pendingImages) {
      image.addEventListener("load", handleImageSettled, { once: true });
      image.addEventListener("error", handleImageSettled, { once: true });
    }

    return () => {
      window.cancelAnimationFrame(frame);
      if (mediaFrame !== null) window.cancelAnimationFrame(mediaFrame);
      for (const image of pendingImages) {
        image.removeEventListener("load", handleImageSettled);
        image.removeEventListener("error", handleImageSettled);
      }
    };
  }, [
    activeTicketId,
    resolutionSignature,
    latestTimelineId,
    timelineMediaSignature,
  ]);

  if (loading) {
    return (
      <section className="flex h-full min-h-0 w-full min-w-0 flex-col bg-card">
        <LoadingState label="Abrindo contexto completo…" />
      </section>
    );
  }

  if (!ticket) {
    return (
      <section className="flex h-full min-h-0 w-full min-w-0 flex-col bg-card max-[1279px]:hidden">
        <EmptyState
          title="Selecione um ticket"
          description="A conversa, a orientação e o resumo do atendimento aparecerão aqui."
        />
      </section>
    );
  }

  const requester = getRequesterPresentation(ticket.requester);
  const revealCategoryPanel = () => {
    setMoreMenuOpen(false);
    if (!categorySectionRef.current) return;
    const panel = categorySectionRef.current.closest("[data-ticket-side-panel]");
    if (panel instanceof HTMLElement) {
      panel.scrollTo({
        top: Math.max(0, categorySectionRef.current.offsetTop - 12),
        behavior: "smooth",
      });
      return;
    }
    categorySectionRef.current.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  };

  return (
    <section className="flex h-full min-h-0 w-full min-w-0 flex-col bg-card" aria-label={`Ticket ${ticket.number}`}>
      <header className="flex min-h-20 shrink-0 items-center gap-3 border-b border-border px-5 py-3 max-[900px]:min-h-[92px] max-[900px]:flex-wrap max-[900px]:items-start max-[900px]:px-2.5 max-[900px]:py-2">
        <Button
          aria-label="Voltar ao Kanban"
          onClick={onBackToKanban}
          size="icon"
          title="Voltar ao Kanban"
          type="button"
          variant="ghost"
        >
          <ArrowLeft size={18} />
        </Button>
        <div className="min-w-44 flex-1 max-[900px]:w-[calc(100%-50px)] max-[900px]:min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-bold text-primary">#{ticket.number}</span>
            <StatusPill status={ticket.status} />
            <PriorityPill priority={ticket.priority} />
          </div>
          <h2 className="mt-1.5 max-w-3xl truncate text-lg font-semibold tracking-tight text-foreground max-[900px]:text-base">{ticket.title}</h2>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {ticket.group.subject}
            {requester ? ` · ${requester.name}` : ""} · {timelineSummary}
          </p>
        </div>
        <div className="flex items-center gap-1.5 max-[900px]:w-full max-[900px]:pl-11">
          {canEditTicket ? (
            <Button
              aria-label="Editar dados do ticket"
              disabled={updatingMetadata}
              onClick={() => setMetadataEditorOpen(true)}
              size="icon"
              title="Editar título, descrição, prioridade e solicitante"
              type="button"
              variant="outline"
            >
              {updatingMetadata ? (
                <LoaderCircle className="animate-spin" size={16} />
              ) : (
                <Pencil size={16} />
              )}
            </Button>
          ) : null}
          <Button onClick={onRefresh} aria-label="Atualizar ticket" size="icon" type="button" variant="outline">
            <RefreshCw size={16} />
          </Button>
          <label className="min-w-0 max-[900px]:flex-1">
            <span className="sr-only">Alterar status interno</span>
            <NativeSelect
              aria-label={ticket.status === "archived" ? "Status arquivado, restaure pelo Kanban" : undefined}
              disabled={updatingStatus || ticket.status === "archived"}
              onChange={(event) => onStatusChange(event.target.value as TicketStatus)}
              value={ticket.status}
              wrapperClassName="w-full"
            >
              {mutableStatuses.map((status) => (
                <option key={status} value={status}>
                  {statusLabels[status]}
                </option>
              ))}
              {ticket.status === "archived" ? (
                <option value="archived">{statusLabels.archived}</option>
              ) : null}
            </NativeSelect>
          </label>
          {ticket.status !== "resolved" && ticket.status !== "archived" ? (
            <Button
              className="max-[1279px]:size-8 max-[1279px]:px-0 max-[1279px]:text-[0px] max-[900px]:w-auto max-[900px]:px-2.5"
              disabled={updatingStatus}
              onClick={() => onStatusChange("resolved")}
              type="button"
              variant="secondary"
            >
              {updatingStatus ? <LoaderCircle className="animate-spin" size={16} /> : <CheckCircle2 size={16} />}
              Marcar como resolvido
            </Button>
          ) : null}
          <div className="relative flex shrink-0" ref={moreMenuRef}>
            <Button
              aria-controls="ticket-more-actions"
              aria-expanded={moreMenuOpen}
              aria-label="Mais opções do ticket"
              disabled={deleting}
              onClick={() => setMoreMenuOpen((current) => !current)}
              size="icon"
              type="button"
              variant="outline"
            >
              {deleting ? (
                <LoaderCircle className="animate-spin" size={17} />
              ) : (
                <MoreHorizontal size={18} />
              )}
            </Button>
            {moreMenuOpen ? (
              <div
                aria-label="Ações do ticket"
                className="absolute top-[calc(100%+7px)] right-0 z-45 w-56 rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-xl"
                id="ticket-more-actions"
              >
                <Button
                  className="h-auto w-full justify-start gap-2.5 p-2 text-left whitespace-normal text-primary"
                  onClick={() => {
                    setMoreMenuOpen(false);
                    onOpenProductForwarding();
                  }}
                  type="button"
                  variant="ghost"
                >
                  {ticket.productForwarding ? (
                    <Pencil size={15} />
                  ) : (
                    <Bug size={15} />
                  )}
                  <span className="flex min-w-0 flex-col">
                    <strong className="text-xs">
                      {ticket.productForwarding
                        ? "Editar bug encaminhado"
                        : "Registrar bug para Produto"}
                    </strong>
                    <small className="mt-1 text-xs leading-snug text-muted-foreground">
                      {ticket.productForwarding
                        ? "Atualize o registro enviado ao Produto"
                        : "Documente este ticket para encaminhamento"}
                    </small>
                  </span>
                </Button>
                <Button
                  className="h-auto w-full justify-start gap-2.5 p-2 text-left whitespace-normal text-primary"
                  onClick={revealCategoryPanel}
                  type="button"
                  variant="ghost"
                >
                  <Tag size={15} />
                  <span className="flex min-w-0 flex-col">
                    <strong className="text-xs">Gerenciar categorias</strong>
                    <small className="mt-1 text-xs leading-snug text-muted-foreground">Classifique este atendimento por categorias</small>
                  </span>
                </Button>
                <Button
                  className="mt-1 h-auto w-full justify-start gap-2.5 border-t border-destructive/10 p-2 text-left whitespace-normal text-destructive"
                  onClick={() => {
                    setMoreMenuOpen(false);
                    setDeleteDialogOpen(true);
                  }}
                  type="button"
                  variant="ghost"
                >
                  <Trash2 size={15} />
                  <span className="flex min-w-0 flex-col">
                    <strong className="text-xs">Excluir permanentemente</strong>
                    <small className="mt-1 text-xs leading-snug text-destructive/70">Apaga o ticket e as análises</small>
                  </span>
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(360px,1fr)_minmax(310px,37%)] overflow-hidden max-[1279px]:grid-cols-[minmax(340px,1fr)_330px] max-[1050px]:grid-cols-1 max-[1050px]:overflow-y-auto">
        <div className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-card overscroll-contain max-[1050px]:min-h-120">
          <div
            className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-muted/20 pb-5 overscroll-contain [scrollbar-gutter:stable]"
            onScroll={(event) => {
              const scroll = event.currentTarget;
              followLatestRef.current =
                scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 96;
            }}
            ref={conversationScrollRef}
          >
            <div className="sticky top-0 z-3 flex min-h-8 items-center justify-center gap-2 border-b border-border bg-card/95 px-3.5 py-1.5 text-xs text-muted-foreground backdrop-blur">
              <ShieldCheck size={15} />
              <span>Conversa capturada do WhatsApp em modo somente leitura</span>
              <Paperclip size={14} />
            </div>
            <TicketConversation
              detachingMessageId={detachingMessageId}
              noteMutation={ticketNoteMutation}
              noteActionReturnFocusRef={noteComposerRef}
              onDetachMessage={
                canManageNotes
                  ? (messageId) => onDetachMessage(ticket.id, messageId)
                  : undefined
              }
              onDeleteNote={
                canManageNotes
                  ? (noteId) => onDeleteNote(ticket.id, noteId)
                  : undefined
              }
              onUpdateNote={
                canManageNotes
                  ? (noteId, body, expectedUpdatedAt) =>
                      onUpdateNote(
                        ticket.id,
                        noteId,
                        body,
                        expectedUpdatedAt,
                      )
                  : undefined
              }
              ticket={ticket}
            />
            <div className="mx-auto my-4 flex w-fit items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs text-emerald-700">
              <CheckCircle2 className="text-emerald-600" size={15} />
              Contexto sincronizado até {formatMessageTime(ticket.lastMessageAt)}
            </div>
            {ticket.resolution ? <TicketResolutionSummary ticket={ticket} /> : null}
            {ticket.resolution && onGenerateDocumentation ? (
              <div className="mx-5 mt-3 flex justify-end">
                <Button disabled={generatingDocumentation} onClick={() => onGenerateDocumentation(ticket.id)} size="sm" variant="outline">
                  {generatingDocumentation ? <LoaderCircle className="animate-spin" size={14} /> : <BookOpenText size={14} />}
                  Gerar documentação
                </Button>
              </div>
            ) : null}
          </div>
          {canManageNotes ? (
            <TicketNoteComposer
              adding={addingNote}
              onAdd={async (body, clientNoteId) => {
                followLatestRef.current = true;
                return onAddNote(ticket.id, body, clientNoteId);
              }}
              textareaRef={noteComposerRef}
            />
          ) : null}
        </div>

        <aside
          className="min-h-0 overflow-y-auto border-l border-border bg-muted/30 overscroll-contain max-[1050px]:overflow-visible max-[1050px]:border-t max-[1050px]:border-l-0"
          data-ticket-side-panel
        >
          <TicketAssignmentPanel
            assignees={assignees}
            canManage={canEditTicket}
            currentUserId={currentUserId}
            onChange={(assigneeId) => onUpdateAssignee(ticket.id, assigneeId)}
            ticket={ticket}
            updating={updatingAssignee}
          />
          <ContextPanel ticket={ticket} />
          <CategoryPanel
            categoryCatalog={categoryCatalog}
            categoryMutationInProgress={categoryMutationTicketId === ticket.id}
            canManageCategories={canManageCategories}
            onOpenCategoryCatalog={onOpenCategoryCatalog}
            onCreateCategory={onCreateCategory}
            onAttachCategory={onAttachCategory}
            onDetachCategory={onDetachCategory}
            sectionRef={categorySectionRef}
            ticket={ticket}
          />
          <ProductForwardingPanel
            onOpen={onOpenProductForwarding}
            ticket={ticket}
          />
          <InvestigationRoomLauncher
            onOpen={onOpenInvestigationRoom}
            ticket={ticket}
          />
        </aside>
      </div>
      {metadataEditorOpen ? (
        <TicketMetadataEditor
          key={ticket.id}
          onCancel={() => setMetadataEditorOpen(false)}
          onSave={(input) =>
            void onUpdateMetadata(ticket.id, input).then((saved) => {
              if (saved) setMetadataEditorOpen(false);
            })
          }
          saving={updatingMetadata}
          ticket={ticket}
        />
      ) : null}
      {deleteDialogOpen ? (
        <TicketDeleteDialog
          deleting={deleting}
          key={ticket.id}
          onCancel={() => setDeleteDialogOpen(false)}
          onConfirm={async (ticketId) => {
            const deleted = await onDelete(ticketId);
            if (deleted) setDeleteDialogOpen(false);
            return deleted;
          }}
          ticket={ticket}
        />
      ) : null}
    </section>
  );
}
