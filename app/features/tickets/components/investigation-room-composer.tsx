import { ArrowUp, LoaderCircle, ShieldCheck } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";

import { Button } from "@/app/components/ui/button";
import { Textarea } from "@/app/components/ui/textarea";
import { INVESTIGATION_THREAD_MESSAGE_MAX_LENGTH } from "@/shared/contracts";

export function InvestigationRoomComposer({
  disabled,
  sending,
  onSend,
}: {
  disabled: boolean;
  sending: boolean;
  onSend: (body: string, clientMessageId: string) => Promise<boolean>;
}) {
  const [body, setBody] = useState("");
  const pendingMessageRef = useRef<{ body: string; id: string } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = body.trim();
    if (!normalized || disabled) return;
    if (pendingMessageRef.current?.body !== normalized) {
      pendingMessageRef.current = { body: normalized, id: crypto.randomUUID() };
    }
    if (await onSend(normalized, pendingMessageRef.current.id)) {
      pendingMessageRef.current = null;
      setBody("");
    }
  }

  return (
    <form
      className="border-t border-border bg-card px-5 py-4"
      onSubmit={(event) => void submit(event)}
    >
      <label className="text-xs font-semibold text-foreground" htmlFor="investigation-room-prompt">
        Converse com a IA sobre este ticket
      </label>
      <div className="mt-2 flex items-end gap-2 max-[620px]:flex-col">
        <Textarea
          autoFocus
          disabled={disabled}
          id="investigation-room-prompt"
          maxLength={INVESTIGATION_THREAD_MESSAGE_MAX_LENGTH}
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder="Ex.: Consulte os dados deste contexto no período informado e confronte banco, logs e integração."
          rows={3}
          className="min-h-20 resize-y"
          value={body}
        />
        <Button className="shrink-0 max-[620px]:w-full" disabled={!body.trim() || disabled} type="submit" variant="default">
          {sending ? (
            <LoaderCircle className="animate-spin" size={16} />
          ) : (
            <ArrowUp size={16} />
          )}
          {sending ? "Registrando…" : "Pedir à IA"}
        </Button>
      </div>
      <small className={`mt-2 flex flex-wrap items-center justify-between gap-2 text-xs ${body.length >= 22_000 ? "text-amber-700" : "text-muted-foreground"}`}>
        <span className="flex items-center gap-1.5">
          <ShieldCheck size={12} /> Esta conversa alimenta apenas a investigação
          e nunca envia mensagens ao WhatsApp.
        </span>
        <b className="font-medium">
          {body.length.toLocaleString("pt-BR")} /{" "}
          {INVESTIGATION_THREAD_MESSAGE_MAX_LENGTH.toLocaleString("pt-BR")}
        </b>
      </small>
    </form>
  );
}
