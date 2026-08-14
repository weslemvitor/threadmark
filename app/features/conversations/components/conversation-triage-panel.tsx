import {
  BellOff,
  BellRing,
  CircleAlert,
  LoaderCircle,
  MessageCircleMore,
  X,
} from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/app/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/app/components/ui/alert-dialog";
import type { ConversationSummary } from "@/app/lib/conversations";
import { cn } from "@/app/lib/utils";
import { ConversationTicketsPanel } from "./conversation-tickets-panel";

export function ConversationTriagePanel({
  mobileOpen,
  error,
  conversation,
  busy,
  ticketRefreshVersion,
  children,
  onClose,
  onKeepPendingAsContext,
  onToggleSuggestions,
  onOpenTicket,
}: {
  mobileOpen: boolean;
  error: string | null;
  conversation: ConversationSummary | null;
  busy: boolean;
  ticketRefreshVersion: number;
  children: ReactNode;
  onClose: () => void;
  onKeepPendingAsContext: () => void;
  onToggleSuggestions: () => void;
  onOpenTicket: (ticketId: string) => void;
}) {
  return (
    <aside
      aria-label="Ações de triagem"
      className={cn(
        "relative min-h-0 min-w-0 overflow-x-hidden overflow-y-auto border-l border-border bg-muted/40 overscroll-contain",
        "max-[900px]:hidden",
        mobileOpen &&
          "max-[900px]:fixed max-[900px]:right-0 max-[900px]:bottom-0 max-[900px]:z-85 max-[900px]:block max-[900px]:w-[min(360px,100vw)] max-[900px]:border-l max-[900px]:bg-muted max-[900px]:shadow-2xl min-[761px]:max-[900px]:top-[72px]",
        mobileOpen &&
          "max-[760px]:top-16 max-[760px]:left-0 max-[760px]:w-full max-[760px]:border-l-0",
      )}
    >
      <div className="sticky top-0 z-10 hidden min-h-15 items-center gap-2.5 border-b border-border bg-card p-3 max-[900px]:flex">
        <div className="flex min-w-0 flex-1 flex-col">
          <strong className="text-sm text-foreground">Triagem da conversa</strong>
          <span className="mt-1 text-xs text-muted-foreground">
            Mensagens e blocos sugeridos
          </span>
        </div>
        <Button
          aria-label="Fechar painel de triagem"
          onClick={onClose}
          size="icon"
          type="button"
          variant="ghost"
        >
          <X size={17} />
        </Button>
      </div>
      {error ? (
        <div className="m-2.5 flex gap-2 rounded-lg border border-destructive/20 bg-destructive/5 p-2.5 text-destructive">
          <CircleAlert className="shrink-0" size={17} />
          <span className="flex min-w-0 flex-col">
            <strong className="text-xs">Não foi possível sincronizar a visão</strong>
            <small className="mt-1 text-xs leading-relaxed">{error}</small>
          </span>
        </div>
      ) : null}
      {conversation ? (
        <section
          className={cn(
            "grid gap-2.5 border-b border-border bg-card p-3.5 max-[1050px]:p-3",
            conversation.suggestionsMuted && "bg-amber-50/70",
          )}
        >
          <div className="flex min-w-0 items-start gap-2">
            <span
              className={cn(
                "grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary",
                conversation.suggestionsMuted &&
                  "bg-amber-100 text-amber-700",
              )}
            >
              {conversation.suggestionsMuted ? (
                <BellOff size={16} />
              ) : (
                <BellRing size={16} />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <strong className="block text-sm leading-snug text-foreground">
                {conversation.suggestionsMuted
                  ? "Sugestões pausadas"
                  : "Sugestões automáticas ativas"}
              </strong>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {conversation.suggestionsMuted
                  ? "As mensagens e anexos continuam salvos, mas não geram blocos sugeridos."
                  : `Pause quando ${
                      conversation.scope === "group"
                        ? "o grupo"
                        : "a conversa"
                    } for apenas interno ou não exigir suporte.`}
              </p>
            </div>
          </div>
          <Button
            className="w-full whitespace-nowrap"
            disabled={busy}
            onClick={onToggleSuggestions}
            size="sm"
            type="button"
            variant={conversation.suggestionsMuted ? "secondary" : "outline"}
          >
            {busy ? (
              <LoaderCircle className="animate-spin" size={14} />
            ) : conversation.suggestionsMuted ? (
              <BellRing size={14} />
            ) : (
              <BellOff size={14} />
            )}
            {conversation.suggestionsMuted
              ? "Reativar sugestões"
              : "Ignorar sugestões"}
          </Button>
          {conversation.pendingCount > 0 ? (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  className="h-auto min-h-9 w-full whitespace-normal px-2 py-1.5 text-center leading-snug"
                  disabled={busy}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <MessageCircleMore className="shrink-0" size={14} />
                  Manter pendências como contexto ({conversation.pendingCount})
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    Manter as pendências desta conversa como contexto?
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    {conversation.pendingCount}{" "}
                    {conversation.pendingCount === 1
                      ? "mensagem sairá"
                      : "mensagens sairão"}{" "}
                    da triagem somente nesta conversa. O histórico, os anexos e
                    os tickets serão preservados.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={busy}>Cancelar</AlertDialogCancel>
                  <AlertDialogAction
                    disabled={busy}
                    onClick={onKeepPendingAsContext}
                  >
                    Manter como contexto
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : null}
        </section>
      ) : null}

      {children}

      {conversation ? (
        <ConversationTicketsPanel
          conversationId={conversation.id}
          onOpenTicket={onOpenTicket}
          refreshVersion={ticketRefreshVersion}
        />
      ) : null}
      {busy ? (
        <div className="sticky bottom-2 mx-auto my-2 flex w-fit items-center gap-1.5 rounded-full bg-slate-800 px-2.5 py-2 text-xs text-white shadow-xl">
          <LoaderCircle className="animate-spin" size={15} /> Atualizando
          triagem…
        </div>
      ) : null}
    </aside>
  );
}
