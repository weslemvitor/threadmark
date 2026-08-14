import {
  Check,
  LoaderCircle,
  Pencil,
  Plus,
  ShieldCheck,
  StickyNote,
  Trash2,
} from "lucide-react";
import {
  type FormEvent,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { Button } from "@/app/components/ui/button";
import { Textarea } from "@/app/components/ui/textarea";
import { formatFullDate } from "@/app/lib/format";
import type { TimelineEventDto } from "@/app/lib/types";
import { TICKET_INTERNAL_NOTE_MAX_LENGTH } from "@/shared/contracts";

export type TicketNoteMutation = {
  noteId: string;
  action: "edit" | "delete";
};

export function InternalNoteItem({
  note,
  mutation,
  onUpdate,
  onDelete,
  returnFocusRef,
}: {
  note: TimelineEventDto;
  mutation: TicketNoteMutation | null;
  onUpdate?: (
    noteId: string,
    body: string,
    expectedUpdatedAt: string,
  ) => Promise<boolean>;
  onDelete?: (noteId: string) => Promise<boolean>;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const body = typeof note.metadata.body === "string" ? note.metadata.body : "";
  const updatedAt =
    typeof note.metadata.updatedAt === "string" ? note.metadata.updatedAt : null;
  const updatedBy =
    typeof note.metadata.updatedBy === "string" ? note.metadata.updatedBy : null;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(body);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const deleteTitleId = useId();
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const cancelDeleteButtonRef = useRef<HTMLButtonElement>(null);
  const confirmDeleteButtonRef = useRef<HTMLButtonElement>(null);
  const editingThisNote =
    mutation?.noteId === note.id && mutation.action === "edit";
  const deletingThisNote =
    mutation?.noteId === note.id && mutation.action === "delete";
  const mutationInProgress = mutation !== null;

  useEffect(() => {
    if (confirmingDelete) cancelDeleteButtonRef.current?.focus();
  }, [confirmingDelete]);

  const cancelEditing = () => {
    setDraft(body);
    setEditing(false);
    window.requestAnimationFrame(() => editButtonRef.current?.focus());
  };

  const cancelDeleting = () => {
    setConfirmingDelete(false);
    window.requestAnimationFrame(() => deleteButtonRef.current?.focus());
  };

  const submitUpdate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = draft.trim();
    if (!normalized || mutationInProgress || !onUpdate) return;
    if (await onUpdate(note.id, normalized, updatedAt ?? note.occurredAt)) {
      setEditing(false);
      window.requestAnimationFrame(() => editButtonRef.current?.focus());
    }
  };

  if (!body) return null;
  return (
    <article
      aria-busy={editingThisNote || deletingThisNote}
      className="mx-5 my-3 flex gap-3 rounded-xl border border-amber-200 bg-amber-50/70 p-4"
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-amber-100 text-amber-700" aria-hidden="true">
        <StickyNote size={15} />
      </span>
      <div className="min-w-0 flex-1">
        <header className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <strong className="text-sm text-amber-950">Nota interna</strong>
          <span className="text-xs text-amber-800">{note.actor}</span>
          {updatedAt ? (
            <span className="text-xs text-muted-foreground">
              Editada por {updatedBy ?? "Operador local"} · {formatFullDate(updatedAt)}
            </span>
          ) : null}
          <time
            className="ml-auto text-xs text-muted-foreground"
            dateTime={note.occurredAt}
            title={`Criada em ${formatFullDate(note.occurredAt)}`}
          >
            {formatFullDate(note.occurredAt)}
          </time>
          {onUpdate || onDelete ? (
            <div className="flex items-center gap-1">
              {onUpdate ? (
                <Button
                  aria-label="Editar nota interna"
                  disabled={mutationInProgress || confirmingDelete}
                  className="size-7 p-0 text-amber-800 hover:text-foreground"
                  onClick={() => {
                    setDraft(body);
                    setEditing(true);
                  }}
                  ref={editButtonRef}
                  size="icon"
                  title="Editar nota"
                  type="button"
                  variant="ghost"
                >
                  {editingThisNote ? (
                    <LoaderCircle className="animate-spin" size={13} />
                  ) : (
                    <Pencil size={13} />
                  )}
                </Button>
              ) : null}
              {onDelete ? (
                <Button
                  aria-label="Excluir nota interna"
                  disabled={mutationInProgress || editing}
                  className="size-7 p-0 text-amber-800 hover:text-destructive"
                  onClick={() => setConfirmingDelete(true)}
                  ref={deleteButtonRef}
                  size="icon"
                  title="Excluir nota"
                  type="button"
                  variant="ghost"
                >
                  {deletingThisNote ? (
                    <LoaderCircle className="animate-spin" size={13} />
                  ) : (
                    <Trash2 size={13} />
                  )}
                </Button>
              ) : null}
            </div>
          ) : null}
        </header>
        {editing ? (
          <form
            aria-label="Editar nota interna"
            className="mt-3 grid gap-2"
            onSubmit={(event) => void submitUpdate(event)}
          >
            <Textarea
              aria-label="Conteúdo da nota interna"
              autoFocus
              disabled={mutationInProgress}
              maxLength={TICKET_INTERNAL_NOTE_MAX_LENGTH}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  cancelEditing();
                  return;
                }
                if (
                  event.key === "Enter" &&
                  (event.metaKey || event.ctrlKey) &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              rows={3}
              value={draft}
            />
            <footer className="flex flex-wrap items-center justify-end gap-2">
              <span className="mr-auto text-xs text-muted-foreground">
                {draft.length.toLocaleString("pt-BR")} /{" "}
                {TICKET_INTERNAL_NOTE_MAX_LENGTH.toLocaleString("pt-BR")}
              </span>
              <Button
                disabled={mutationInProgress}
                onClick={cancelEditing}
                size="sm"
                type="button"
                variant="outline"
              >
                Cancelar
              </Button>
              <Button
                disabled={
                  mutationInProgress ||
                  !draft.trim() ||
                  draft.trim() === body.trim()
                }
                size="sm"
                type="submit"
                variant="default"
              >
                {editingThisNote ? (
                  <LoaderCircle className="animate-spin" size={13} />
                ) : (
                  <Check size={13} />
                )}
                {editingThisNote ? "Salvando…" : "Salvar"}
              </Button>
            </footer>
          </form>
        ) : (
          <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-amber-950 [overflow-wrap:anywhere]">
            {body}
          </p>
        )}
        {confirmingDelete && onDelete ? (
          <div
            aria-labelledby={deleteTitleId}
            className="mt-3 grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 rounded-lg border border-destructive/25 bg-background/80 p-3 max-[620px]:grid-cols-1"
            onKeyDown={(event) => {
              if (event.key === "Escape" && !deletingThisNote) {
                event.preventDefault();
                cancelDeleting();
                return;
              }
              if (event.key === "Tab") {
                const cancelButton = cancelDeleteButtonRef.current;
                const confirmButton = confirmDeleteButtonRef.current;
                if (
                  event.shiftKey &&
                  document.activeElement === cancelButton &&
                  confirmButton
                ) {
                  event.preventDefault();
                  confirmButton.focus();
                } else if (
                  !event.shiftKey &&
                  document.activeElement === confirmButton &&
                  cancelButton
                ) {
                  event.preventDefault();
                  cancelButton.focus();
                }
              }
            }}
            role="alertdialog"
          >
            <div className="min-w-0">
              <strong className="block text-xs text-foreground" id={deleteTitleId}>Excluir esta nota?</strong>
              <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                O conteúdo será apagado do SQLite; apenas a ação continuará
                auditada.
              </span>
            </div>
            <Button
              disabled={deletingThisNote}
              onClick={cancelDeleting}
              ref={cancelDeleteButtonRef}
              size="sm"
              type="button"
              variant="outline"
            >
              Cancelar
            </Button>
            <Button
              disabled={deletingThisNote}
              onClick={() => {
                void onDelete(note.id).then((deleted) => {
                  if (deleted) {
                    setConfirmingDelete(false);
                    window.requestAnimationFrame(() =>
                      returnFocusRef?.current?.focus(),
                    );
                  }
                });
              }}
              ref={confirmDeleteButtonRef}
              size="sm"
              type="button"
              variant="destructive"
            >
              {deletingThisNote ? (
                <LoaderCircle className="animate-spin" size={13} />
              ) : (
                <Trash2 size={13} />
              )}
              {deletingThisNote ? "Excluindo…" : "Excluir nota"}
            </Button>
          </div>
        ) : null}
      </div>
    </article>
  );
}

export function TicketNoteComposer({
  adding,
  onAdd,
  textareaRef,
}: {
  adding: boolean;
  onAdd: (body: string, clientNoteId: string) => Promise<boolean>;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
}) {
  const [body, setBody] = useState("");
  const pendingNoteRef = useRef<{ body: string; id: string } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = body.trim();
    if (!normalized || adding) return;
    if (pendingNoteRef.current?.body !== normalized) {
      pendingNoteRef.current = { body: normalized, id: crypto.randomUUID() };
    }
    if (await onAdd(normalized, pendingNoteRef.current.id)) {
      pendingNoteRef.current = null;
      setBody("");
    }
  }

  return (
    <form className="shrink-0 border-t border-border bg-card px-5 py-4" onSubmit={(event) => void submit(event)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <StickyNote size={14} /> Adicionar nota interna
        </span>
        <small className="text-xs text-muted-foreground">⌘/Ctrl + Enter para salvar</small>
      </div>
      <div className="mt-2 flex items-end gap-2 max-[620px]:flex-col">
        <Textarea
          aria-label="Nota interna do ticket"
          disabled={adding}
          maxLength={TICKET_INTERNAL_NOTE_MAX_LENGTH}
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              (event.metaKey || event.ctrlKey) &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder="Registre o andamento, uma decisão ou o próximo passo deste ticket…"
          ref={textareaRef}
          rows={2}
          className="min-h-20 resize-y"
          value={body}
        />
        <Button className="shrink-0 max-[620px]:w-full" disabled={!body.trim() || adding} type="submit" variant="default">
          {adding ? (
            <LoaderCircle className="animate-spin" size={15} />
          ) : (
            <Plus size={15} />
          )}
          {adding ? "Salvando…" : "Adicionar nota"}
        </Button>
      </div>
      <footer className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <ShieldCheck size={12} /> Visível apenas no Threadmark e nunca é enviada ao WhatsApp.
        </span>
        <b className="font-medium">
          {body.length.toLocaleString("pt-BR")} /{" "}
          {TICKET_INTERNAL_NOTE_MAX_LENGTH.toLocaleString("pt-BR")}
        </b>
      </footer>
    </form>
  );
}
