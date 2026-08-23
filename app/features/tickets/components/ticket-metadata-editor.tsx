import { Button } from "@/app/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/app/components/ui/dialog";
import { Input } from "@/app/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
import { Textarea } from "@/app/components/ui/textarea";
import {
  FilePenLine,
  LoaderCircle,
  Save,
  ShieldCheck,
  UserRound,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  TICKET_PRIORITIES,
  TICKET_SUMMARY_MAX_LENGTH,
  TICKET_TITLE_MAX_LENGTH,
  type TicketDetailDto,
  type TicketPriority,
  type UpdateTicketMetadataInput,
} from "@/shared/contracts.js";
import { formatPhoneNumber, priorityLabels } from "@/app/lib/format";

export type TicketMetadataEditorProps = {
  ticket: TicketDetailDto;
  saving: boolean;
  onCancel: () => void;
  onSave: (input: UpdateTicketMetadataInput) => unknown;
};

export function TicketMetadataEditor({
  ticket,
  saving,
  onCancel,
  onSave,
}: TicketMetadataEditorProps) {
  const [title, setTitle] = useState(ticket.title);
  const [summary, setSummary] = useState(ticket.summary);
  const [priority, setPriority] = useState<TicketPriority>(ticket.priority);
  const [requesterId, setRequesterId] = useState(
    ticket.requesterOverrideId ?? "",
  );

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || saving) return;
      event.preventDefault();
      onCancel();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel, saving]);

  const normalizedTitle = title.trim();
  const normalizedSummary = summary.trim();
  const input = useMemo<UpdateTicketMetadataInput>(
    () => ({
      title: normalizedTitle,
      summary: normalizedSummary,
      priority,
      requesterId: requesterId || null,
    }),
    [normalizedSummary, normalizedTitle, priority, requesterId],
  );
  const changed =
    input.title !== ticket.title ||
    input.summary !== ticket.summary ||
    input.priority !== ticket.priority ||
    input.requesterId !== ticket.requesterOverrideId;
  const valid = Boolean(input.title && input.summary);
  const automaticRequester = ticket.requester
    ? `${ticket.requester.displayName}${
        ticket.requester.phoneE164
          ? ` · ${formatPhoneNumber(ticket.requester.phoneE164)}`
          : ""
      }`
    : "Ainda não identificado";
  const unavailableRequester =
    ticket.requesterOverrideId &&
    !ticket.requesterCandidates.some(
      (candidate) => candidate.id === ticket.requesterOverrideId,
    )
      ? ticket.requester
      : null;

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onCancel(); }}>
      <DialogContent
        className="max-h-[calc(100dvh-1rem)] w-[calc(100%-1rem)] max-w-2xl gap-0 overflow-hidden p-0 sm:max-h-[calc(100dvh-2rem)] sm:w-full sm:max-w-3xl"
        onEscapeKeyDown={(event) => { if (saving) event.preventDefault(); }}
        onInteractOutside={(event) => { if (saving) event.preventDefault(); }}
        showCloseButton={false}
      >
      <form
        className="flex max-h-[calc(100dvh-1rem)] min-h-0 flex-col sm:max-h-[calc(100dvh-2rem)]"
        onSubmit={(event) => {
          event.preventDefault();
          if (!changed || !valid || saving) return;
          void onSave(input);
        }}
      >
        <DialogHeader className="relative flex-row items-start gap-3 border-b border-border px-4 py-4 pr-12 text-left sm:px-5 sm:pr-14">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
            <FilePenLine size={20} />
          </span>
          <div className="min-w-0">
            <span className="text-xs font-semibold uppercase tracking-wide text-primary">Ticket #{ticket.number}</span>
            <DialogTitle className="mt-1 text-lg">Editar dados do ticket</DialogTitle>
            <DialogDescription className="mt-1">
              Ajuste a identificação e a descrição interna deste atendimento.
            </DialogDescription>
          </div>
          <Button
            aria-label="Fechar edição do ticket"
            className="absolute right-4 top-4"
            disabled={saving}
            onClick={onCancel}
            size="icon"
            type="button"
            variant="ghost"
          >
            <X size={18} />
          </Button>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-5 sm:px-5">
          <section className="space-y-4">
            <div className="flex items-start gap-3">
              <FilePenLine className="mt-0.5 text-primary" size={17} />
              <div>
                <strong className="block text-sm text-foreground">Identificação do atendimento</strong>
                <span className="text-xs text-muted-foreground">Esses dados aparecem nas listas, no Kanban e nas análises.</span>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <label className="grid min-w-0 gap-1.5 text-xs font-medium text-foreground sm:col-span-2">
                <span>Título</span>
                <Input
                  autoFocus
                  disabled={saving}
                  maxLength={TICKET_TITLE_MAX_LENGTH}
                  onChange={(event) => setTitle(event.target.value)}
                  required
                  value={title}
                />
                <small className="text-right text-xs font-normal text-muted-foreground">
                  {title.length.toLocaleString("pt-BR")} /{" "}
                  {TICKET_TITLE_MAX_LENGTH.toLocaleString("pt-BR")}
                </small>
              </label>
              <label className="grid min-w-0 gap-1.5 self-start text-xs font-medium text-foreground">
                <span>Prioridade</span>
                <Select
                  disabled={saving}
                  onValueChange={(value) => setPriority(value as TicketPriority)}
                  value={priority}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TICKET_PRIORITIES.map((option) => (
                      <SelectItem key={option} value={option}>
                        {priorityLabels[option]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <label className="grid min-w-0 gap-1.5 text-xs font-medium text-foreground sm:col-span-3">
                <span>Descrição</span>
                <Textarea
                  disabled={saving}
                  maxLength={TICKET_SUMMARY_MAX_LENGTH}
                  onChange={(event) => setSummary(event.target.value)}
                  required
                  rows={6}
                  value={summary}
                />
                <small className="text-right text-xs font-normal text-muted-foreground">
                  {summary.length.toLocaleString("pt-BR")} /{" "}
                  {TICKET_SUMMARY_MAX_LENGTH.toLocaleString("pt-BR")}
                </small>
              </label>
            </div>
          </section>

          <section className="space-y-4 border-t border-border pt-5">
            <div className="flex items-start gap-3">
              <UserRound className="mt-0.5 text-primary" size={17} />
              <div>
                <strong className="block text-sm text-foreground">Solicitante</strong>
                <span className="text-xs text-muted-foreground">Somente participantes ativos desta conversa aparecem aqui.</span>
              </div>
            </div>
            <label className="grid gap-1.5 text-xs font-medium text-foreground">
              <span>Pessoa solicitante</span>
              <Select
                disabled={saving}
                onValueChange={(value) => setRequesterId(
                  value === "__automatic__" ? "" : value,
                )}
                value={requesterId || "__automatic__"}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__automatic__">
                    Detectar automaticamente · {automaticRequester}
                  </SelectItem>
                  {unavailableRequester && ticket.requesterOverrideId ? (
                    <SelectItem disabled value={ticket.requesterOverrideId}>
                      {unavailableRequester.displayName} · não está mais no grupo
                    </SelectItem>
                  ) : null}
                  {ticket.requesterCandidates.map((candidate) => (
                    <SelectItem key={candidate.id} value={candidate.id}>
                      {candidate.displayName}
                      {candidate.phoneE164
                        ? ` · ${formatPhoneNumber(candidate.phoneE164)}`
                        : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <small className="font-normal leading-relaxed text-muted-foreground">
                A escolha manual prevalece sobre a primeira mensagem externa do
                ticket. Selecione a detecção automática para remover essa preferência.
              </small>
            </label>
          </section>

          <div className="flex gap-3 rounded-lg border border-emerald-200 bg-emerald-50/70 p-3" role="note">
            <ShieldCheck className="mt-0.5 shrink-0 text-emerald-700" size={17} />
            <div>
              <strong className="block text-xs text-emerald-950">Somente organização interna</strong>
              <p className="mt-1 text-xs leading-relaxed text-emerald-900/75">
                A edição fica salva no SQLite e no histórico do ticket. Nenhuma
                mensagem é enviada ao WhatsApp.
              </p>
            </div>
          </div>
        </div>

        <DialogFooter className="m-0 flex-col-reverse items-stretch rounded-none px-4 py-4 sm:flex-row sm:items-center sm:justify-end sm:px-5">
          <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto">
            <Button
              className="min-w-0"
              disabled={saving}
              onClick={onCancel}
              type="button"
              variant="outline"
            >
              Cancelar
            </Button>
            <Button
              className="min-w-0"
              disabled={!changed || !valid || saving}
              type="submit"
              variant="default"
            >
              {saving ? (
                <LoaderCircle className="animate-spin" size={16} />
              ) : (
                <Save size={16} />
              )}
              {saving ? "Salvando…" : "Salvar alterações"}
            </Button>
          </div>
        </DialogFooter>
      </form>
      </DialogContent>
    </Dialog>
  );
}
