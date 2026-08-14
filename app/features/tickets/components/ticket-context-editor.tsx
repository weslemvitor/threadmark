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
  FolderTree,
  Layers3,
  LoaderCircle,
  Save,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type {
  DirectorySnapshotDto,
  TicketDetailDto,
  UpdateTicketDirectoryContextInput,
} from "@/shared/contracts.js";

export type TicketContextEditorProps = {
  ticket: TicketDetailDto;
  snapshot: DirectorySnapshotDto | null;
  saving: boolean;
  onCancel: () => void;
  onOpenDirectory: () => void;
  onSave: (input: UpdateTicketDirectoryContextInput) => unknown;
};

function sameIds(left: string[], right: string[]): boolean {
  return left.toSorted().join("\u0000") === right.toSorted().join("\u0000");
}

function sourceLabel(sources: Array<"ticket" | "group" | "requester">): string {
  const labels = sources.flatMap((source) => {
    if (source === "group") return ["Vinculado ao grupo"];
    if (source === "requester") return ["Vinculado ao solicitante"];
    return ["Específico deste ticket"];
  });
  return labels.join(" · ");
}

export function TicketContextEditor({
  ticket,
  snapshot,
  saving,
  onCancel,
  onOpenDirectory,
  onSave,
}: TicketContextEditorProps) {
  const originalIds = ticket.directoryContext.explicitRecordIds;
  const [selectedIds, setSelectedIds] = useState(() => new Set(originalIds));
  const [query, setQuery] = useState("");

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || saving) return;
      event.preventDefault();
      onCancel();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel, saving]);

  const typeById = useMemo(
    () => new Map((snapshot?.recordTypes ?? []).map((type) => [type.id, type])),
    [snapshot],
  );
  const contextByRecordId = useMemo(
    () => new Map(ticket.directoryContext.records.map((record) => [record.id, record])),
    [ticket.directoryContext.records],
  );
  const records = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("pt-BR");
    return (snapshot?.records ?? [])
      .filter((record) => !record.archivedAt)
      .filter((record) => {
        if (!normalizedQuery) return true;
        const type = typeById.get(record.typeId);
        return [record.name, record.description, type?.name]
          .filter(Boolean)
          .some((value) =>
            value?.toLocaleLowerCase("pt-BR").includes(normalizedQuery),
          );
      })
      .toSorted((left, right) => {
        const leftType = typeById.get(left.typeId)?.name ?? "";
        const rightType = typeById.get(right.typeId)?.name ?? "";
        return (
          leftType.localeCompare(rightType, "pt-BR") ||
          left.name.localeCompare(right.name, "pt-BR")
        );
      });
  }, [query, snapshot, typeById]);
  const selectedRecordIds = [...selectedIds].toSorted();
  const changed = !sameIds(selectedRecordIds, originalIds);

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onCancel(); }}>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-2xl gap-0 overflow-hidden p-0 sm:max-w-2xl"
        onEscapeKeyDown={(event) => { if (saving) event.preventDefault(); }}
        onInteractOutside={(event) => { if (saving) event.preventDefault(); }}
        showCloseButton={false}
      >
      <form
        className="flex max-h-[calc(100dvh-2rem)] min-h-0 min-w-0 flex-col overflow-hidden"
        onSubmit={(event) => {
          event.preventDefault();
          if (!changed || saving) return;
          void onSave({ recordIds: selectedRecordIds });
        }}
      >
        <DialogHeader className="relative min-w-0 flex-row items-start gap-3 border-b border-border px-4 py-4 pr-14 text-left sm:px-5">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
            <FolderTree size={20} />
          </span>
          <div className="min-w-0">
            <span className="text-xs font-semibold uppercase tracking-wide text-primary">Contexto do atendimento</span>
            <DialogTitle className="mt-1 text-lg">Vincular registros do Diretório</DialogTitle>
            <DialogDescription className="mt-1 break-words [overflow-wrap:anywhere]">
              Escolha classificações específicas para o ticket #{ticket.number}.
            </DialogDescription>
          </div>
          <Button
            aria-label="Fechar associação de registros"
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

        <div className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-5 sm:py-5">
          <div className="flex gap-3 rounded-lg border border-primary/20 bg-primary/5 p-3" role="note">
            <Layers3 className="mt-0.5 shrink-0 text-primary" size={17} />
            <div className="min-w-0">
              <strong className="block text-xs text-foreground">O contexto continua agnóstico</strong>
              <p className="mt-1 break-words text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
                Registros ligados ao grupo ou ao solicitante aparecem automaticamente.
                Aqui você adiciona somente os registros específicos deste ticket.
              </p>
            </div>
          </div>

          {(snapshot?.records.length ?? 0) > 0 ? (
            <>
              <label className="relative block" htmlFor="ticket-directory-search">
                <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={15} />
                <Input
                  className="pl-9"
                  autoFocus
                  id="ticket-directory-search"
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Buscar registro ou tipo"
                  type="search"
                  value={query}
                />
              </label>
              <div className="mt-3 grid max-h-80 gap-2 overflow-y-auto pr-1">
                {records.map((record) => {
                  const type = typeById.get(record.typeId);
                  const context = contextByRecordId.get(record.id);
                  const inheritedSources = context?.sources.filter(
                    (source) => source !== "ticket",
                  ) ?? [];
                  return (
                    <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-background p-3 transition-colors hover:border-primary/40 hover:bg-muted/40" key={record.id}>
                      <Input
                        checked={selectedIds.has(record.id)}
                        disabled={saving}
                        onChange={(event) => {
                          setSelectedIds((current) => {
                            const next = new Set(current);
                            if (event.target.checked) next.add(record.id);
                            else next.delete(record.id);
                            return next;
                          });
                        }}
                        type="checkbox"
                      />
                      <span
                        className="mt-1.5 size-2.5 shrink-0 rounded-full bg-primary"
                        style={{ backgroundColor: type?.color ?? undefined }}
                      />
                      <span className="min-w-0 flex-1">
                        <small className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground">{type?.name ?? "Registro"}</small>
                        <strong className="mt-0.5 block break-words text-sm text-foreground">{record.name}</strong>
                        {record.description ? <span className="mt-1 block break-words text-xs leading-relaxed text-muted-foreground">{record.description}</span> : null}
                        {inheritedSources.length ? (
                          <em className="mt-1.5 block text-xs not-italic text-primary">{sourceLabel(inheritedSources)}</em>
                        ) : null}
                      </span>
                    </label>
                  );
                })}
                {!records.length ? (
                  <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-xs text-muted-foreground">
                    Nenhum registro corresponde a “{query.trim()}”.
                  </p>
                ) : null}
              </div>
            </>
          ) : (
            <div className="grid min-w-0 justify-items-center rounded-xl border border-dashed border-border px-4 py-8 text-center sm:px-6 sm:py-10">
              <FolderTree className="text-muted-foreground" size={24} />
              <strong className="mt-3 text-sm text-foreground">Nenhum registro personalizado criado</strong>
              <p className="mt-1 max-w-md break-words text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
                Crie tipos, campos e registros no Diretório; depois eles poderão ser
                vinculados aos grupos, pessoas e tickets.
              </p>
              <Button
                className="mt-4"
                onClick={() => {
                  onCancel();
                  onOpenDirectory();
                }}
                type="button"
                variant="outline"
              >
                Abrir Diretório
              </Button>
            </div>
          )}

          <div className="flex gap-3 rounded-lg border border-emerald-200 bg-emerald-50/70 p-3" role="status">
            <ShieldCheck className="mt-0.5 shrink-0 text-emerald-700" size={17} />
            <div className="min-w-0">
              <strong className="block text-xs text-emerald-950">Somente organização interna</strong>
              <p className="mt-1 break-words text-xs leading-relaxed text-emerald-900/75 [overflow-wrap:anywhere]">
                A associação melhora o contexto do ticket e da investigação, sem
                alterar ou enviar qualquer mensagem do WhatsApp.
              </p>
            </div>
          </div>
        </div>

        <DialogFooter className="m-0 grid w-full min-w-0 grid-cols-1 items-center gap-3 rounded-none px-4 py-4 sm:grid-cols-1 sm:px-5 md:grid-cols-[minmax(0,1fr)_auto]">
          <Button
            className="w-full min-w-0 whitespace-normal text-center md:w-fit md:justify-start md:text-left"
            onClick={() => {
              onCancel();
              onOpenDirectory();
            }}
            type="button"
            variant="ghost"
          >
            Criar ou editar campos no Diretório
          </Button>
          <div className="grid w-full min-w-0 grid-cols-2 gap-2 md:w-auto">
            <Button
              className="w-full min-w-0"
              disabled={saving}
              onClick={onCancel}
              type="button"
              variant="outline"
            >
              Cancelar
            </Button>
            <Button
              className="w-full min-w-0"
              disabled={!changed || saving}
              type="submit"
              variant="default"
            >
              {saving ? (
                <LoaderCircle className="animate-spin" size={16} />
              ) : (
                <Save size={16} />
              )}
              {saving ? "Salvando…" : "Salvar vínculos"}
            </Button>
          </div>
        </DialogFooter>
      </form>
      </DialogContent>
    </Dialog>
  );
}
