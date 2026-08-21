"use client";

import {
  Archive,
  BookOpenText,
  Check,
  Clipboard,
  Download,
  FileWarning,
  LoaderCircle,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";

import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { Card } from "@/app/components/ui/card";
import { Checkbox } from "@/app/components/ui/checkbox";
import { Input } from "@/app/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/app/components/ui/tabs";
import { Textarea } from "@/app/components/ui/textarea";
import {
  API_URL,
  deleteDocumentationDraft,
  getDocumentationDocx,
  getDocumentationDrafts,
  regenerateDocumentation,
  updateDocumentationDraft,
} from "@/app/lib/api";
import type { DocumentationDraft } from "@/app/lib/types";
import type { DocumentationDraftStatus } from "@/shared/contracts";
import { DocumentationDeleteDialog } from "./documentation-delete-dialog";

const statusLabels: Record<DocumentationDraftStatus, string> = {
  draft: "Em revisão",
  ready: "Pronta",
  archived: "Arquivada",
};

function markdownFor(draft: DocumentationDraft): string {
  const prerequisites = draft.prerequisites.length
    ? `\n\n## Pré-requisitos\n\n${draft.prerequisites.map((item) => `- ${item}`).join("\n")}`
    : "";
  return `# ${draft.title}\n\n${draft.summary}${prerequisites}\n\n${draft.bodyMarkdown}`.trim();
}

function editableSignature(draft: DocumentationDraft): string {
  return JSON.stringify({
    title: draft.title,
    summary: draft.summary,
    audience: draft.audience,
    bodyMarkdown: draft.bodyMarkdown,
    prerequisites: draft.prerequisites,
    status: draft.status,
  });
}

export function DocumentationView() {
  const [items, setItems] = useState<DocumentationDraft[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DocumentationDraft | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const selected = items.find((item) => item.id === selectedId) ?? items[0] ?? null;
  const [draft, setDraft] = useState<DocumentationDraft | null>(null);
  const selectedSnapshotRef = useRef<DocumentationDraft | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const response = await getDocumentationDrafts({ query, includeArchived });
      setItems(response.items);
      setSelectedId((current) =>
        current && response.items.some((item) => item.id === current)
          ? current
          : response.items[0]?.id ?? null,
      );
      setMessage(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Não foi possível carregar as documentações.");
    } finally {
      setLoading(false);
    }
  }, [includeArchived, query]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void load());
    return () => window.cancelAnimationFrame(frame);
  }, [load]);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setDraft((current) => {
        const previous = selectedSnapshotRef.current;
        selectedSnapshotRef.current = selected;
        const hasLocalChanges = Boolean(
          current && previous && current.id === previous.id &&
          editableSignature(current) !== editableSignature(previous),
        );
        return hasLocalChanges && current?.id === selected?.id
          ? current
          : selected ? structuredClone(selected) : null;
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [selected]);

  const hasActiveGeneration = items.some((item) =>
    item.generationState === "queued" || item.generationState === "running",
  );
  useEffect(() => {
    if (!hasActiveGeneration) return;
    const timer = window.setInterval(() => void load(true), 2_000);
    return () => window.clearInterval(timer);
  }, [hasActiveGeneration, load]);

  const dirty = useMemo(() => Boolean(
    selected && draft && editableSignature(draft) !== editableSignature(selected),
  ), [draft, selected]);

  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      const updated = await updateDocumentationDraft(draft.id, {
        title: draft.title,
        summary: draft.summary,
        audience: draft.audience,
        bodyMarkdown: draft.bodyMarkdown,
        prerequisites: draft.prerequisites,
        status: draft.status,
      });
      setItems((current) => current.map((item) => item.id === updated.id ? updated : item));
      setMessage("Documentação salva no SQLite.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Não foi possível salvar.");
    } finally {
      setSaving(false);
    }
  }

  async function regenerate() {
    if (!draft) return;
    try {
      const updated = await regenerateDocumentation(draft.id);
      setItems((current) => current.map((item) => item.id === updated.id ? updated : item));
      setMessage("Nova geração adicionada à fila.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Não foi possível gerar novamente.");
    }
  }

  async function remove(target: DocumentationDraft) {
    setDeleting(true);
    try {
      await deleteDocumentationDraft(target.id);
      const remaining = items.filter((item) => item.id !== target.id);
      setItems(remaining);
      setSelectedId(remaining[0]?.id ?? null);
      setDraft(null);
      setDeleteTarget(null);
      setMessage("Documentação excluída definitivamente do SQLite.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Não foi possível excluir a documentação.");
      setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  }

  async function download() {
    if (!draft) return;
    setExporting(true);
    try {
      const result = await getDocumentationDocx(draft.id);
      const url = URL.createObjectURL(result.blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = result.fileName;
      anchor.click();
      URL.revokeObjectURL(url);
      setMessage("Documentação exportada em DOCX para enviar ao Intercom.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Não foi possível exportar o DOCX.");
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="grid min-h-full grid-cols-[minmax(260px,330px)_minmax(0,1fr)] gap-4 p-4 max-[900px]:grid-cols-1">
      <Card className="min-w-0 gap-0 overflow-hidden p-0">
        <div className="border-b p-4">
          <div className="flex items-center justify-between gap-3">
            <div><h2 className="text-sm font-semibold">Rascunhos</h2><p className="mt-1 text-xs text-muted-foreground">{items.length} documentação(ões)</p></div>
            <Button aria-label="Atualizar" onClick={() => void load()} size="icon-sm" variant="outline"><RefreshCw size={14} /></Button>
          </div>
          <div className="relative mt-3"><Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={15} /><Input className="pl-9" onChange={(event) => setQuery(event.target.value)} placeholder="Buscar documentação" value={query} /></div>
          <label className="mt-3 flex items-center gap-2 text-xs text-muted-foreground"><Checkbox checked={includeArchived} onCheckedChange={(checked) => setIncludeArchived(checked === true)} /> Mostrar arquivadas</label>
        </div>
        <div className="grid max-h-[calc(100dvh-260px)] gap-2 overflow-y-auto p-3 max-[900px]:max-h-72">
          {loading ? <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground"><LoaderCircle className="animate-spin" size={16} /> Carregando</div> : null}
          {!loading && !items.length ? <div className="p-8 text-center"><BookOpenText className="mx-auto text-muted-foreground" size={28} /><p className="mt-3 text-sm font-medium">Nenhum rascunho ainda</p><p className="mt-1 text-xs leading-5 text-muted-foreground">Abra um ticket resolvido e escolha gerar documentação.</p></div> : null}
          {items.map((item) => (
            <Button className={`h-auto min-w-0 justify-start rounded-xl border p-3 text-left transition-colors hover:bg-muted ${selected?.id === item.id ? "border-primary bg-primary/5" : "border-border"}`} key={item.id} onClick={() => setSelectedId(item.id)} type="button" variant="ghost"><span className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2"><span className="text-xs font-semibold text-primary">Ticket #{item.ticketNumber}</span><Badge variant="secondary">{statusLabels[item.status]}</Badge></div>
              <strong className="mt-2 block truncate text-sm">{item.title || item.ticketTitle}</strong>
              {item.generationState === "queued" || item.generationState === "running" ? <span className="mt-2 flex items-center gap-1 text-xs text-primary"><LoaderCircle className="animate-spin" size={12} /> Gerando rascunho</span> : null}
              {item.generationState === "failed" ? <span className="mt-2 flex items-center gap-1 text-xs text-destructive"><FileWarning size={12} /> Falha na geração</span> : null}
            </span></Button>
          ))}
        </div>
      </Card>

      <Card className="min-w-0 gap-0 overflow-hidden p-0">
        {message ? <div className="border-b bg-muted/50 px-4 py-2 text-xs text-muted-foreground" role="status">{message}</div> : null}
        {!draft ? <div className="grid min-h-96 place-items-center p-8 text-center text-sm text-muted-foreground">Selecione uma documentação para revisar.</div> : (
          <>
            <header className="flex flex-wrap items-start justify-between gap-3 border-b p-4">
              <div className="min-w-0"><p className="text-xs font-semibold uppercase tracking-wide text-primary">Rascunho do ticket #{draft.ticketNumber}</p><h2 className="mt-1 break-words text-lg font-semibold">{draft.title || draft.ticketTitle}</h2><p className="mt-1 text-xs text-muted-foreground">Revise antes de copiar ou exportar. Nada é publicado automaticamente.</p></div>
              <div className="flex flex-wrap gap-2"><Button onClick={() => void navigator.clipboard.writeText(markdownFor(draft))} size="sm" variant="outline"><Clipboard size={14} /> Copiar</Button><Button disabled={exporting} onClick={() => void download()} size="sm" variant="outline">{exporting ? <LoaderCircle className="animate-spin" size={14} /> : <Download size={14} />} {exporting ? "Exportando…" : "Exportar DOCX"}</Button><Button onClick={() => void regenerate()} size="sm" variant="outline"><RefreshCw size={14} /> Gerar novamente</Button><Button onClick={() => setDeleteTarget(draft)} size="sm" variant="destructive"><Trash2 size={14} /> Excluir</Button></div>
            </header>
            <Tabs className="min-h-0 flex-col gap-0" defaultValue="edit">
              <div className="border-b px-4 pt-3"><TabsList><TabsTrigger value="edit">Editar</TabsTrigger><TabsTrigger value="preview">Prévia</TabsTrigger><TabsTrigger value="sources">Fontes e imagens</TabsTrigger></TabsList></div>
              <TabsContent className="m-0 grid gap-4 p-4" value="edit">
                <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1"><label className="grid gap-1.5 text-xs font-medium">Título<Input maxLength={160} onChange={(event) => setDraft({ ...draft, title: event.target.value })} value={draft.title} /></label><label className="grid gap-1.5 text-xs font-medium">Público<Input maxLength={200} onChange={(event) => setDraft({ ...draft, audience: event.target.value })} value={draft.audience} /></label></div>
                <label className="grid gap-1.5 text-xs font-medium">Resumo<Textarea className="min-h-20" maxLength={600} onChange={(event) => setDraft({ ...draft, summary: event.target.value })} value={draft.summary} /></label>
                <label className="grid gap-1.5 text-xs font-medium">Pré-requisitos, um por linha<Textarea className="min-h-20" onChange={(event) => setDraft({ ...draft, prerequisites: event.target.value.split("\n") })} value={draft.prerequisites.join("\n")} /></label>
                <label className="grid gap-1.5 text-xs font-medium">Conteúdo em Markdown<Textarea className="min-h-80 font-mono text-sm" maxLength={30_000} onChange={(event) => setDraft({ ...draft, bodyMarkdown: event.target.value })} value={draft.bodyMarkdown} /></label>
                <div className="flex flex-wrap items-center justify-between gap-3"><Select onValueChange={(status) => setDraft({ ...draft, status: status as DocumentationDraftStatus })} value={draft.status}><SelectTrigger aria-label="Status da documentação" className="w-44"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="draft">Em revisão</SelectItem><SelectItem value="ready">Pronta</SelectItem><SelectItem value="archived">Arquivada</SelectItem></SelectContent></Select><Button disabled={!dirty || saving} onClick={() => void save()}>{saving ? <LoaderCircle className="animate-spin" size={14} /> : <Check size={14} />} Salvar alterações</Button></div>
              </TabsContent>
              <TabsContent className="m-0 p-5" value="preview"><article className="mx-auto max-w-3xl whitespace-pre-wrap break-words text-sm leading-7"><h1 className="mb-3 text-2xl font-bold">{draft.title}</h1><p className="mb-5 text-muted-foreground">{draft.summary}</p>{draft.prerequisites.length ? <><h2 className="mb-2 mt-5 text-lg font-semibold">Pré-requisitos</h2><ul className="list-disc pl-5">{draft.prerequisites.filter(Boolean).map((item) => <li key={item}>{item}</li>)}</ul></> : null}<div className="mt-5">{draft.bodyMarkdown}</div></article></TabsContent>
              <TabsContent className="m-0 grid gap-4 p-4" value="sources">
                {draft.warnings.length ? <div className="rounded-xl border border-amber-200 bg-amber-50 p-4"><h3 className="flex items-center gap-2 text-sm font-semibold text-amber-900"><FileWarning size={16} /> Pontos para revisão</h3><ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-800">{draft.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div> : null}
                <p className="text-xs text-muted-foreground">{draft.sourceMessageIds.length} mensagem(ns) sustentam este rascunho.</p>
                <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">{draft.images.map((image) => <figure className="overflow-hidden rounded-xl border" key={image.attachmentId}><Image alt={image.caption} className="h-auto max-h-72 w-full object-contain" height={540} src={`${API_URL}${image.url}`} unoptimized width={960} /><figcaption className="border-t p-3 text-xs text-muted-foreground">{image.caption}</figcaption></figure>)}</div>
                {!draft.images.length ? <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground"><Archive className="mx-auto mb-2" size={20} /> Nenhuma imagem segura foi selecionada.</div> : null}
              </TabsContent>
            </Tabs>
          </>
        )}
      </Card>
      <DocumentationDeleteDialog
        deleting={deleting}
        draft={deleteTarget}
        onConfirm={remove}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      />
    </div>
  );
}
