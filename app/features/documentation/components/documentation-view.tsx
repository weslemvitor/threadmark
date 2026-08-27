"use client";

import {
  Archive,
  BookOpenText,
  Check,
  Clipboard,
  Download,
  FileWarning,
  ShieldCheck,
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
  generateKnowledgeDocument,
  getDocumentationDocx,
  getDocumentationDrafts,
  regenerateDocumentation,
  reviewKnowledgeObject,
  updateKnowledgeObject,
  updateDocumentationDraft,
} from "@/app/lib/api";
import type { DocumentationDraft, KnowledgeObject } from "@/app/lib/types";
import type { DocumentationDraftStatus, KnowledgeAudience, KnowledgeCandidateDecision, KnowledgeConfidence, KnowledgeDocumentType, KnowledgeFeedbackReason } from "@/shared/contracts";
import { DocumentationDeleteDialog } from "./documentation-delete-dialog";

const statusLabels: Record<DocumentationDraftStatus, string> = {
  draft: "Em revisão",
  ready: "Pronta",
  archived: "Arquivada",
};

const confidenceLabels: Record<KnowledgeConfidence, string> = { HIGH: "Alta", MEDIUM: "Média", LOW: "Baixa" };
const candidateLabels: Record<KnowledgeCandidateDecision, string> = { YES: "Sim", NO: "Não", UNCERTAIN: "Incerto" };
const audienceLabels: Record<KnowledgeAudience, string> = { SUPPORT: "Suporte", TECHNICAL: "Técnico", CUSTOMER: "Cliente" };
const typeLabels: Record<KnowledgeDocumentType, string> = {
  FAQ: "FAQ", HOW_TO: "Passo a passo", TROUBLESHOOTING: "Solução de problemas",
  EXPLANATION: "Explicação", INTERNAL_RUNBOOK: "Runbook interno", CUSTOMER_FACING: "Conteúdo para cliente",
};
const feedbackLabels: Record<KnowledgeFeedbackReason, string> = {
  TOO_TECHNICAL: "Técnico demais", TOO_GENERIC: "Genérico demais", MISSING_STEP: "Falta um passo",
  INCORRECT: "Incorreto", UNSUPPORTED: "Sem evidência", WRONG_AUDIENCE: "Público incorreto",
  DUPLICATE: "Duplicado", MISSING_CONTEXT: "Falta contexto",
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
  const [knowledge, setKnowledge] = useState<KnowledgeObject | null>(null);
  const [savingKnowledge, setSavingKnowledge] = useState(false);
  const [feedbackReason, setFeedbackReason] = useState<KnowledgeFeedbackReason>("UNSUPPORTED");
  const [feedbackComment, setFeedbackComment] = useState("");
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
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setKnowledge(selected?.knowledgeObject ? structuredClone(selected.knowledgeObject) : null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [selected?.knowledgeObject]);

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

  async function saveKnowledge() {
    if (!knowledge) return;
    setSavingKnowledge(true);
    try {
      const updated = await updateKnowledgeObject(knowledge.id, {
        status: knowledge.status,
        candidate: knowledge.candidate,
        confidence: knowledge.confidence,
        suggestedType: knowledge.suggestedType,
        audience: knowledge.audience,
        title: knowledge.title,
        problem: knowledge.problem,
        symptom: knowledge.symptom,
        context: knowledge.context,
        cause: knowledge.cause,
        technicalCause: knowledge.technicalCause,
        solution: knowledge.solution,
        procedure: knowledge.procedure.filter(Boolean),
        prerequisites: knowledge.prerequisites.filter(Boolean),
        occurrenceConditions: knowledge.occurrenceConditions,
        applicableConditions: knowledge.applicableConditions,
        contraindications: knowledge.contraindications,
        impact: knowledge.impact,
        affectedAudience: knowledge.affectedAudience,
        productFeature: knowledge.productFeature,
        causes: knowledge.causes,
        claims: knowledge.claims,
        evidence: knowledge.evidence,
        operationalEvidenceIds: knowledge.operationalEvidenceIds,
        toolsUsed: knowledge.toolsUsed,
        relatedTicketIds: knowledge.relatedTicketIds,
        unknowns: knowledge.unknowns.filter(Boolean),
        confirmationsNeeded: knowledge.confirmationsNeeded.filter(Boolean),
        languageLevels: knowledge.languageLevels,
      });
      setKnowledge(updated);
      setItems((current) => current.map((item) => item.id === draft?.id ? { ...item, knowledgeObject: updated } : item));
      setMessage("Conhecimento versionado e salvo no SQLite.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Não foi possível salvar o conhecimento.");
    } finally {
      setSavingKnowledge(false);
    }
  }

  async function reviewKnowledge(decision: "APPROVE" | "REJECT") {
    if (!knowledge) return;
    try {
      const updated = await reviewKnowledgeObject(knowledge.id, {
        decision,
        reasons: decision === "REJECT" ? [feedbackReason] : [],
        comment: decision === "REJECT" ? feedbackComment.trim() || null : null,
      });
      setKnowledge(updated);
      setItems((current) => current.map((item) => item.id === draft?.id ? { ...item, knowledgeObject: updated } : item));
      setMessage(decision === "APPROVE" ? "Conhecimento aprovado." : "Conhecimento rejeitado e preservado para auditoria.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Não foi possível revisar o conhecimento.");
    }
  }

  async function generateDocument() {
    if (!knowledge || !draft) return;
    try {
      const updated = await generateKnowledgeDocument(knowledge.id);
      setItems((current) => current.map((item) => item.id === updated.id ? updated : item));
      setMessage("Documento adicionado à fila de renderização segura.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Não foi possível gerar o documento.");
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
              <div className="flex flex-wrap gap-2"><Button onClick={() => void navigator.clipboard.writeText(markdownFor(draft))} size="sm" variant="outline"><Clipboard size={14} /> Copiar</Button><Button disabled={exporting || !draft.bodyMarkdown} onClick={() => void download()} size="sm" variant="outline">{exporting ? <LoaderCircle className="animate-spin" size={14} /> : <Download size={14} />} {exporting ? "Exportando…" : "Exportar DOCX"}</Button>{knowledge?.extractedAt ? <Button disabled={knowledge.candidate === "NO"} onClick={() => void generateDocument()} size="sm"><BookOpenText size={14} /> Gerar documentação</Button> : null}<Button onClick={() => void regenerate()} size="sm" variant="outline"><RefreshCw size={14} /> Extrair novamente</Button><Button onClick={() => setDeleteTarget(draft)} size="sm" variant="destructive"><Trash2 size={14} /> Excluir</Button></div>
            </header>
            <Tabs className="min-h-0 flex-col gap-0" defaultValue="knowledge">
              <div className="border-b px-4 pt-3"><TabsList><TabsTrigger value="knowledge">Conhecimento</TabsTrigger><TabsTrigger value="edit">Documento</TabsTrigger><TabsTrigger value="preview">Prévia</TabsTrigger><TabsTrigger value="sources">Evidências</TabsTrigger></TabsList></div>
              <TabsContent className="m-0 grid gap-4 p-4" value="knowledge">
                {!knowledge?.extractedAt ? <div className="rounded-xl border border-dashed p-8 text-center"><LoaderCircle className="mx-auto animate-spin text-primary" size={24} /><p className="mt-3 text-sm font-semibold">Extraindo conhecimento do ticket</p><p className="mt-1 text-xs text-muted-foreground">Fatos, hipóteses e evidências serão preservados separadamente.</p></div> : (
                  <>
                    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-muted/30 p-4">
                      <div><p className="text-xs font-semibold uppercase tracking-wide text-primary">Conhecimento identificado</p><p className="mt-1 text-sm text-muted-foreground">Versão {knowledge.version} · {knowledge.evidence.length} evidência(s) · revisão humana obrigatória</p></div>
                      <div className="flex flex-wrap gap-2"><Badge variant={knowledge.confidence === "HIGH" ? "default" : "secondary"}>Confiança {confidenceLabels[knowledge.confidence]}</Badge><Badge variant="outline">{typeLabels[knowledge.suggestedType]}</Badge><Badge variant="outline">{audienceLabels[knowledge.audience]}</Badge><Badge variant={knowledge.candidate === "YES" ? "default" : "secondary"}>Reutilizável: {candidateLabels[knowledge.candidate]}</Badge></div>
                    </div>
                    {knowledge.confidence === "LOW" || knowledge.confirmationsNeeded.length ? <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><p className="font-semibold">⚠️ Conhecimento ainda não confirmado</p><p className="mt-1 text-xs leading-5">Hipóteses e informações desconhecidas não serão transformadas em instruções operacionais.</p></div> : null}
                    {knowledge.duplicate ? <div className="rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-900"><p className="font-semibold">Possível duplicidade: {knowledge.duplicate.title}</p><p className="mt-1 text-xs">Similaridade {Math.round(knowledge.duplicate.similarity * 100)}%. Considere atualizar o conhecimento existente.</p></div> : null}
                    <label className="grid gap-1.5 text-xs font-medium">Título<Input maxLength={200} onChange={(event) => setKnowledge({ ...knowledge, title: event.target.value })} value={knowledge.title} /></label>
                    <div className="grid grid-cols-3 gap-3 max-lg:grid-cols-1">
                      <label className="grid gap-1.5 text-xs font-medium">Confiança<Select onValueChange={(value) => setKnowledge({ ...knowledge, confidence: value as KnowledgeConfidence })} value={knowledge.confidence}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="HIGH">Alta</SelectItem><SelectItem value="MEDIUM">Média</SelectItem><SelectItem value="LOW">Baixa</SelectItem></SelectContent></Select></label>
                      <label className="grid gap-1.5 text-xs font-medium">Tipo<Select onValueChange={(value) => setKnowledge({ ...knowledge, suggestedType: value as KnowledgeDocumentType })} value={knowledge.suggestedType}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{Object.entries(typeLabels).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select></label>
                      <label className="grid gap-1.5 text-xs font-medium">Público<Select onValueChange={(value) => setKnowledge({ ...knowledge, audience: value as KnowledgeAudience })} value={knowledge.audience}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{Object.entries(audienceLabels).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select></label>
                    </div>
                    <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
                      <label className="grid gap-1.5 text-xs font-medium">Problema<Textarea className="min-h-24" onChange={(event) => setKnowledge({ ...knowledge, problem: event.target.value || null })} value={knowledge.problem ?? ""} /></label>
                      <label className="grid gap-1.5 text-xs font-medium">Sintoma<Textarea className="min-h-24" onChange={(event) => setKnowledge({ ...knowledge, symptom: event.target.value || null })} value={knowledge.symptom ?? ""} /></label>
                      <label className="grid gap-1.5 text-xs font-medium">Causa confirmada<Textarea className="min-h-24" onChange={(event) => setKnowledge({ ...knowledge, cause: event.target.value || null })} value={knowledge.cause ?? ""} /></label>
                      <label className="grid gap-1.5 text-xs font-medium">Solução confirmada<Textarea className="min-h-24" onChange={(event) => setKnowledge({ ...knowledge, solution: event.target.value || null })} value={knowledge.solution ?? ""} /></label>
                    </div>
                    <label className="grid gap-1.5 text-xs font-medium">Procedimento comprovado, um passo por linha<Textarea className="min-h-28" onChange={(event) => setKnowledge({ ...knowledge, procedure: event.target.value.split("\n") })} value={knowledge.procedure.join("\n")} /></label>
                    <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1"><label className="grid gap-1.5 text-xs font-medium">Informações desconhecidas<Textarea className="min-h-24" onChange={(event) => setKnowledge({ ...knowledge, unknowns: event.target.value.split("\n") })} value={knowledge.unknowns.join("\n")} /></label><label className="grid gap-1.5 text-xs font-medium">Informações a confirmar<Textarea className="min-h-24" onChange={(event) => setKnowledge({ ...knowledge, confirmationsNeeded: event.target.value.split("\n") })} value={knowledge.confirmationsNeeded.join("\n")} /></label></div>
                    <div className="grid gap-3 rounded-xl border bg-muted/20 p-4"><p className="text-xs font-semibold">Feedback da revisão</p><div className="grid grid-cols-[220px_minmax(0,1fr)] gap-3 max-md:grid-cols-1"><Select onValueChange={(value) => setFeedbackReason(value as KnowledgeFeedbackReason)} value={feedbackReason}><SelectTrigger aria-label="Motivo da rejeição"><SelectValue /></SelectTrigger><SelectContent>{Object.entries(feedbackLabels).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select><Input onChange={(event) => setFeedbackComment(event.target.value)} placeholder="Comentário opcional para melhorar a próxima geração" value={feedbackComment} /></div></div>
                    <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex gap-2"><Button onClick={() => void reviewKnowledge("APPROVE")} size="sm" variant="outline"><ShieldCheck size={14} /> Aprovar</Button><Button onClick={() => void reviewKnowledge("REJECT")} size="sm" variant="destructive">Rejeitar</Button></div><Button disabled={savingKnowledge} onClick={() => void saveKnowledge()}>{savingKnowledge ? <LoaderCircle className="animate-spin" size={14} /> : <Check size={14} />} Salvar conhecimento</Button></div>
                  </>
                )}
              </TabsContent>
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
                {knowledge?.claims.length ? <div className="grid gap-2"><h3 className="text-sm font-semibold">Afirmações classificadas</h3>{knowledge.claims.map((claim) => <div className="rounded-xl border p-3" key={claim.id}><div className="flex flex-wrap items-center gap-2"><Badge variant={claim.kind === "HYPOTHESIS" ? "secondary" : "outline"}>{claim.kind}</Badge><Badge variant="secondary">{claim.confidence}</Badge><span className="text-[11px] text-muted-foreground">{claim.evidenceIds.length} evidência(s)</span></div><p className="mt-2 text-sm leading-6">{claim.statement}</p></div>)}</div> : null}
                {knowledge?.evidence.length ? <div className="grid gap-2"><h3 className="text-sm font-semibold">Origem do conhecimento</h3>{knowledge.evidence.map((evidence) => <div className="rounded-xl border bg-muted/20 p-3" key={evidence.id}><div className="flex items-center justify-between gap-2"><Badge variant="outline">{evidence.source}</Badge><code className="break-all text-[11px] text-muted-foreground">{evidence.reference}</code></div><p className="mt-2 break-words text-xs leading-5 text-muted-foreground">{evidence.excerpt}</p></div>)}</div> : null}
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
