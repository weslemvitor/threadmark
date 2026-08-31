import {
  CircleAlert,
  ListChecks,
  LoaderCircle,
  LockKeyhole,
  MessagesSquare,
  Search,
} from "lucide-react";

import { EmptyState, LoadingState } from "@/app/components/shared";
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
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import type { ConversationSummary } from "@/app/lib/conversations";
import { ConversationListItem } from "./conversation-list-item";

export type ConversationFilter = "pending" | "all" | "group" | "direct";

const filterOptions: Array<{ id: ConversationFilter; label: string }> = [
  { id: "pending", label: "Pendentes" },
  { id: "all", label: "Todas" },
  { id: "group", label: "Grupos" },
  { id: "direct", label: "Privadas" },
];

export function ConversationDirectory({
  conversations,
  conversationTotal,
  pendingTotal,
  filteredConversations,
  selectedConversationId,
  filter,
  query,
  loading,
  loadingMore,
  keepingAllPending,
  hasMore,
  error,
  onFilterChange,
  onKeepAllPendingAsContext,
  onQueryChange,
  onRetry,
  onLoadMore,
  onSelect,
}: {
  conversations: ConversationSummary[];
  conversationTotal: number;
  pendingTotal: number;
  filteredConversations: ConversationSummary[];
  selectedConversationId: string | null;
  filter: ConversationFilter;
  query: string;
  loading: boolean;
  loadingMore: boolean;
  keepingAllPending: boolean;
  hasMore: boolean;
  error: string | null;
  onFilterChange: (filter: ConversationFilter) => void;
  onKeepAllPendingAsContext: () => void;
  onQueryChange: (query: string) => void;
  onRetry: () => void;
  onLoadMore: () => void;
  onSelect: (conversationId: string) => void;
}) {
  return (
    <section
      className={`flex min-h-0 min-w-0 flex-col border-r border-border bg-muted/20 max-[760px]:h-full max-[760px]:w-full max-[760px]:border-r-0 ${
        selectedConversationId ? "max-[760px]:hidden" : ""
      }`}
      aria-label="Lista de conversas"
    >
      <div className="flex min-h-[67px] items-center gap-2 px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-foreground">Conversas</h2>
          <span className="mt-1 block text-xs text-muted-foreground">
            {pendingTotal} {pendingTotal === 1 ? "mensagem pendente" : "mensagens pendentes"} ·{" "}
            {conversationTotal || conversations.length} conversas
          </span>
        </div>
        <span className="inline-flex min-h-6 items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 text-xs font-semibold whitespace-nowrap text-emerald-700 max-[900px]:hidden">
          <LockKeyhole size={12} /> <span>Somente leitura</span>
        </span>
      </div>
      <label className="mx-3 mb-2 flex h-9 shrink-0 items-center gap-2 rounded-lg border border-border bg-card px-2.5 text-muted-foreground focus-within:border-primary/50 focus-within:ring-3 focus-within:ring-primary/10">
        <Search className="shrink-0" size={16} />
        <Input
          className="h-auto min-w-0 flex-1 border-0 bg-transparent p-0 text-xs shadow-none focus-visible:border-0 focus-visible:ring-0"
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Buscar grupo, contato ou registro"
          type="search"
          value={query}
        />
      </label>
      <div className="flex min-h-9 shrink-0 items-start gap-1 overflow-x-auto px-3 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {filterOptions.map((option) => (
          <Button
            key={option.id}
            onClick={() => onFilterChange(option.id)}
            size="sm"
            type="button"
            variant={filter === option.id ? "secondary" : "ghost"}
          >
            {option.label}
          </Button>
        ))}
      </div>
      {pendingTotal > 0 ? (
        <div className="shrink-0 px-3 pb-2">
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                className="w-full"
                disabled={keepingAllPending || loading}
                size="sm"
                type="button"
                variant="outline"
              >
                {keepingAllPending ? (
                  <LoaderCircle className="animate-spin" size={14} />
                ) : (
                  <ListChecks size={14} />
                )}
                {keepingAllPending
                  ? "Mantendo como contexto…"
                  : `Manter todas como contexto (${pendingTotal})`}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  Manter todas as pendências como contexto?
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {pendingTotal} {pendingTotal === 1 ? "mensagem sairá" : "mensagens sairão"} da fila de triagem em todas as conversas. Todas as sugestões pendentes também serão recusadas. Mensagens, anexos e tickets serão preservados, e novas mensagens continuarão entrando normalmente.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={keepingAllPending}>
                  Cancelar
                </AlertDialogCancel>
                <AlertDialogAction
                  disabled={keepingAllPending}
                  onClick={onKeepAllPendingAsContext}
                >
                  Manter como contexto
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto border-t border-border overscroll-contain">
        {error ? (
          <div className="m-2.5 grid grid-cols-[auto_minmax(0,1fr)] gap-2 rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-xs leading-relaxed text-destructive" role="alert">
            <CircleAlert className="mt-0.5" size={16} />
            <span className="min-w-0 break-words">{error}</span>
            <Button
              className="col-span-2"
              onClick={onRetry}
              type="button"
              variant="outline"
            >
              Tentar novamente
            </Button>
          </div>
        ) : null}
        {loading ? <LoadingState label="Carregando conversas…" /> : null}
        {!loading && !filteredConversations.length ? (
          <EmptyState
            title={
              filter === "pending"
                ? "Nenhuma pendência"
                : "Nenhuma conversa encontrada"
            }
            description={
              filter === "pending"
                ? "As mensagens foram triadas. A captura continua acompanhando o WhatsApp."
                : "Ajuste a busca ou troque o filtro."
            }
          />
        ) : null}
        {filteredConversations.map((conversation) => (
          <ConversationListItem
            conversation={conversation}
            key={conversation.id}
            onSelect={() => onSelect(conversation.id)}
            selected={selectedConversationId === conversation.id}
          />
        ))}
        {hasMore ? (
          <div className="flex justify-center px-3 py-3">
            <Button
              disabled={loadingMore}
              onClick={onLoadMore}
              size="sm"
              type="button"
              variant="outline"
            >
              {loadingMore ? (
                <LoaderCircle className="animate-spin" size={14} />
              ) : (
                <MessagesSquare size={14} />
              )}
              {loadingMore ? "Carregando…" : "Carregar mais conversas"}
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
