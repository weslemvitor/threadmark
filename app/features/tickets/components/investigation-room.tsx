import {
  AlertCircle,
  BrainCircuit,
  CheckCircle2,
  CircleStop,
  FileSearch,
  LoaderCircle,
  MessageSquareText,
  ShieldCheck,
  UserRound,
  UsersRound,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  type InvestigationThreadDto,
} from "@/shared/contracts";
import {
  formatFullDate,
  getSuggestedResponse,
  getRequesterPresentation,
} from "@/app/lib/format";
import {
  getInvestigationThreadPresentation,
  getInvestigationTurnLabel,
  isInvestigationTurnActive,
  type InvestigationTurnState,
} from "@/app/lib/investigation-thread";
import type { TicketDetail } from "@/app/lib/types";
import { TicketConversation } from "./ticket-conversation";
import { Button } from "@/app/components/ui/button";
import { Dialog, DialogContent } from "@/app/components/ui/dialog";
import { InvestigationRoomComposer } from "./investigation-room-composer";
import { InvestigationRoomMessage } from "./investigation-room-message";
import { cn } from "@/app/lib/utils";

type MobilePane = "conversation" | "codex";

type InvestigationRoomProps = {
  ticket: TicketDetail;
  thread: InvestigationThreadDto | null;
  loading: boolean;
  sending: boolean;
  stopping: boolean;
  error: string | null;
  onClose: () => void;
  onRefresh: () => void;
  onSend: (body: string, clientMessageId: string) => Promise<boolean>;
  onStop: () => void;
};

function ThreadStatus({ thread }: { thread: InvestigationThreadDto | null }) {
  const latestTurnState = thread?.turns.at(-1)?.state;
  const presentation = getInvestigationThreadPresentation(
    thread?.activeTurnState,
    latestTurnState,
    thread?.status,
  );

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold",
        presentation.active && "border-primary/20 bg-primary/10 text-primary",
        presentation.failed && "border-destructive/20 bg-destructive/10 text-destructive",
        presentation.cancelled && "border-amber-200 bg-amber-50 text-amber-700",
        !presentation.active &&
          !presentation.failed &&
          !presentation.cancelled &&
          "border-emerald-200 bg-emerald-50 text-emerald-700",
      )}
    >
      {presentation.active ? (
        <LoaderCircle className="animate-spin" size={14} />
      ) : presentation.failed ? (
        <AlertCircle size={14} />
      ) : presentation.cancelled ? (
        <CircleStop size={14} />
      ) : (
        <CheckCircle2 size={14} />
      )}
      {presentation.label}
    </span>
  );
}

export function InvestigationRoom({
  ticket,
  thread,
  loading,
  sending,
  stopping,
  error,
  onClose,
  onRefresh,
  onSend,
  onStop,
}: InvestigationRoomProps) {
  const [mobilePane, setMobilePane] = useState<MobilePane>("codex");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const turnState = thread?.activeTurnState as InvestigationTurnState | undefined;
  const active = isInvestigationTurnActive(turnState);
  const latestTurn = thread?.turns.at(-1) ?? null;
  const requester = getRequesterPresentation(ticket.requester);
  const currentSuggestedResponse = getSuggestedResponse(ticket);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: "end" });
  }, [thread?.messages.length, turnState]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      const searchOverlayOpen = document.querySelector(
        '[data-support-search-overlay="true"]',
      );
      if (event.key === "Escape" && !active && !sending && !searchOverlayOpen) onClose();
    }
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [active, onClose, sending]);

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !active && !sending) onClose(); }}>
      <DialogContent
        aria-label={`Sala de investigação do ticket ${ticket.number}`}
        className="h-[calc(100dvh-2rem)] max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-none grid-rows-[auto_auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-w-[calc(100vw-2rem)]"
        onEscapeKeyDown={(event) => { if (active || sending) event.preventDefault(); }}
        onInteractOutside={(event) => event.preventDefault()}
        showCloseButton={false}
      >
        <header className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-4 border-b border-border px-5 py-4 max-[760px]:grid-cols-1 max-[760px]:gap-3">
          <div className="min-w-0">
            <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-primary">
              <BrainCircuit size={15} /> Sala de investigação persistente
            </span>
            <h2 className="mt-1 break-words text-lg font-semibold text-foreground">
              <small className="mr-1 text-primary">#{ticket.number}</small> {ticket.title}
            </h2>
            <p className="mt-1 break-words text-xs text-muted-foreground">
              {ticket.group.subject}
              {requester ? ` · ${requester.compact}` : ""} · tudo salvo no SQLite
            </p>
          </div>
          <div className="flex min-w-0 shrink-0 flex-wrap items-center justify-end gap-2 max-[760px]:justify-start">
            <ThreadStatus thread={thread} />
            {active ? (
              <Button
                aria-label="Parar investigação em andamento"
                disabled={stopping}
                onClick={onStop}
                size="sm"
                type="button"
                variant="destructive"
              >
                {stopping ? (
                  <LoaderCircle className="animate-spin" size={16} />
                ) : (
                  <CircleStop size={16} />
                )}
                <span>{stopping ? "Parando…" : "Parar investigação"}</span>
              </Button>
            ) : null}
            <Button
              aria-label="Atualizar sala de investigação"
              disabled={loading}
              onClick={onRefresh}
              size="icon"
              type="button"
              variant="outline"
            >
              {loading ? <LoaderCircle className="animate-spin" size={17} /> : <FileSearch size={17} />}
            </Button>
            <Button
              aria-label="Fechar sala de investigação"
              onClick={onClose}
              size="icon"
              type="button"
              variant="outline"
            >
              <X size={18} />
            </Button>
          </div>
        </header>

        <nav className="hidden grid-cols-2 border-b border-border p-2 max-[760px]:grid" aria-label="Conteúdo da investigação">
          <Button
            aria-pressed={mobilePane === "conversation"}
            className="gap-2"
            onClick={() => setMobilePane("conversation")}
            type="button"
            variant={mobilePane === "conversation" ? "secondary" : "ghost"}
          >
            <MessageSquareText size={15} /> Conversa WhatsApp
          </Button>
          <Button
            aria-pressed={mobilePane === "codex"}
            className="gap-2"
            onClick={() => setMobilePane("codex")}
            type="button"
            variant={mobilePane === "codex" ? "secondary" : "ghost"}
          >
            <BrainCircuit size={15} /> Chat com IA
          </Button>
        </nav>

        <div className="grid min-h-0 flex-1 grid-cols-[minmax(320px,0.85fr)_minmax(420px,1.15fr)] max-[900px]:grid-cols-[minmax(280px,0.8fr)_minmax(380px,1.2fr)] max-[760px]:block">
          <aside
            className={cn(
              "grid min-h-0 grid-rows-[auto_auto_minmax(0,1fr)] border-r border-border bg-muted/20 max-[760px]:hidden max-[760px]:h-full max-[760px]:border-r-0",
              mobilePane === "conversation" && "max-[760px]:grid",
            )}
          >
            <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-3">
              <div>
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Contexto completo</span>
                <h3 className="mt-0.5 text-sm font-semibold text-foreground">Conversa do WhatsApp</h3>
              </div>
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700">
                <ShieldCheck size={13} /> Somente leitura
              </span>
            </div>
            <div className="grid gap-2 border-b border-border px-5 py-3">
              <div className="flex min-w-0 items-start gap-2 text-xs">
                <UsersRound className="shrink-0 text-muted-foreground" size={14} />
                <span className="min-w-0">
                  <small className="block text-xs text-muted-foreground">Grupo</small>
                  <strong className="block truncate text-foreground">{ticket.group.subject}</strong>
                </span>
              </div>
              <div className="flex min-w-0 items-start gap-2 text-xs">
                <UserRound className="shrink-0 text-muted-foreground" size={14} />
                <span className="min-w-0">
                  <small className="block text-xs text-muted-foreground">Solicitante</small>
                  <strong className="block truncate text-foreground">{requester?.name ?? "Ainda não identificado"}</strong>
                </span>
              </div>
            </div>
            <div className="min-h-0 overflow-y-auto">
              <TicketConversation ticket={ticket} />
              <div className="mx-5 mb-5 flex items-center justify-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
                <CheckCircle2 size={14} /> Contexto sincronizado até {formatFullDate(ticket.lastMessageAt)}
              </div>
            </div>
          </aside>

          <main
            className={cn(
              "grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] bg-background max-[760px]:hidden max-[760px]:h-full",
              mobilePane === "codex" && "max-[760px]:grid",
            )}
          >
            <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-3">
              <div>
                <span className="text-xs font-semibold uppercase tracking-wide text-primary">Investigação profunda</span>
                <h3 className="mt-0.5 text-sm font-semibold text-foreground">Conversa com o agente de IA</h3>
              </div>
              {thread ? (
                <small className="text-right text-xs text-muted-foreground">
                  Atualizada {formatFullDate(thread.updatedAt)} · histórico persistido
                </small>
              ) : null}
            </div>

            <div className="min-h-0 overflow-y-auto px-5 py-5" aria-live="polite">
              {thread?.summary ? (
                <details className="mb-4 rounded-lg border border-border bg-muted/30 px-3 py-2">
                  <summary className="cursor-pointer text-xs font-semibold text-foreground">Memória da investigação</summary>
                  <p className="mt-2 whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">{thread.summary}</p>
                </details>
              ) : null}

              {loading && !thread ? (
                <div className="grid min-h-64 place-items-center content-center gap-2 text-center text-muted-foreground">
                  <LoaderCircle className="animate-spin text-primary" size={24} />
                  <strong className="text-sm text-foreground">Preparando a sala…</strong>
                  <p className="text-xs">Recuperando do SQLite todo o histórico desta investigação.</p>
                </div>
              ) : error && !thread ? (
                <div className="flex gap-3 rounded-lg border border-destructive/20 bg-destructive/5 p-4" role="alert">
                  <AlertCircle className="shrink-0 text-destructive" size={20} />
                  <div>
                    <strong className="block text-sm text-foreground">Não foi possível abrir a sala</strong>
                    <p className="mt-1 text-xs text-muted-foreground">{error}</p>
                    <Button className="mt-3" onClick={onRefresh} size="sm" type="button" variant="outline">Tentar novamente</Button>
                  </div>
                </div>
              ) : thread && !thread.messages.length ? (
                <div className="grid min-h-64 place-items-center content-center gap-2 text-center">
                  <span className="grid size-11 place-items-center rounded-xl bg-primary/10 text-primary"><BrainCircuit size={24} /></span>
                  <strong className="text-sm text-foreground">A sala está pronta</strong>
                  <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
                    Peça uma investigação, complemente o contexto ou questione a análise anterior.
                    O agente de IA já receberá o ticket e a conversa completa.
                  </p>
                </div>
              ) : null}

              {thread?.messages.map((message) => (
                <InvestigationRoomMessage
                  currentSuggestedResponse={currentSuggestedResponse}
                  key={message.id}
                  message={message}
                />
              ))}

              {active ? (
                <div className="mt-4 flex gap-3 rounded-lg border border-primary/20 bg-primary/5 p-4" role="status">
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"><LoaderCircle className="animate-spin" size={17} /></span>
                  <div>
                    <strong className="block text-sm text-foreground">{getInvestigationTurnLabel(turnState)}</strong>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      O agente está explorando as ferramentas autorizadas e esta sala será atualizada
                      automaticamente. A execução continuará até concluir, encontrar um bloqueio real
                      ou você clicar em Parar investigação.
                    </p>
                  </div>
                </div>
              ) : null}

              {latestTurn?.state === "failed" && latestTurn.error ? (
                <div className="mt-4 flex gap-3 rounded-lg border border-destructive/20 bg-destructive/5 p-3" role="alert">
                  <AlertCircle className="shrink-0 text-destructive" size={16} />
                  <div>
                    <strong className="block text-xs text-foreground">Esta tentativa falhou</strong>
                    <p className="mt-1 text-xs text-muted-foreground">{latestTurn.error}</p>
                  </div>
                </div>
              ) : null}

              {latestTurn?.state === "cancelled" ? (
                <div className="mt-4 flex gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3" role="status">
                  <CircleStop className="shrink-0 text-amber-700" size={16} />
                  <div>
                    <strong className="block text-xs text-foreground">Investigação interrompida</strong>
                    <p className="mt-1 text-xs text-muted-foreground">As mensagens, o mapa de trabalho e todas as operações executadas foram preservados no SQLite.</p>
                  </div>
                </div>
              ) : null}

              {error && thread ? (
                <div className="mt-4 flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">
                  <AlertCircle size={15} /> {error}
                </div>
              ) : null}
              <div ref={messagesEndRef} />
            </div>

            <InvestigationRoomComposer
              disabled={!thread || active || stopping || sending || loading}
              onSend={onSend}
              sending={sending}
            />
          </main>
        </div>
      </DialogContent>
    </Dialog>
  );
}
