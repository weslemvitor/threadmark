"use client";

import {
  AlertTriangle,
  CheckCircle2,
  CirclePause,
  FlaskConical,
  LoaderCircle,
  Plus,
  Save,
  Trash2,
  Workflow,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/app/components/ui/alert-dialog";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { Card } from "@/app/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/app/components/ui/dialog";
import { Input } from "@/app/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/app/components/ui/tabs";
import { Textarea } from "@/app/components/ui/textarea";
import { cn } from "@/app/lib/utils";
import {
  activateAutomation,
  createAutomation,
  createConnectedApp,
  deleteAutomation,
  deleteConnectedApp,
  getAutomation,
  listAutomations,
  listConnectedApps,
  listNotificationRecipients,
  pauseAutomation,
  testAutomation,
  testConnectedApp,
  updateAutomation,
  updateAutomationLayout,
  updateAutomationMetadata,
  updateConnectedApp,
} from "../data";
import {
  automationNodeCatalogId,
  automationNodeDefinition,
  catalogWithConnectedApps,
  automationMetadataSignature,
  editableAutomationSignature,
  initialNodeConfig,
  validateAutomation,
  type AutomationDefinition,
  type AutomationDetail,
  type AutomationExecution,
  type AutomationNodeDto,
  type AutomationSummary,
  type ConnectedAppSummary,
  type UpsertConnectedAppInput,
} from "../domain";
import type { TicketAssigneeDto } from "@/shared/contracts";
import { AutomationCanvas } from "./automation-canvas";
import { AutomationList } from "./automation-list";
import { ConnectedAppsPanel } from "./connected-apps-panel";
import { NodeCatalogSheet } from "./node-catalog-sheet";
import { NodeConfigSheet } from "./node-config-sheet";

type Section = "flows" | "apps";
type Notice = { tone: "success" | "warning"; message: string } | null;

const emptyDefinition: AutomationDefinition = { version: 1, nodes: [], edges: [] };

type AutomationLayoutNode = {
  id: string;
  position: { x: number; y: number };
};

function automationWithLayout(
  automation: AutomationDetail,
  layout: AutomationLayoutNode[],
): AutomationDetail {
  const positions = new Map(layout.map((node) => [node.id, node.position]));
  return {
    ...automation,
    definition: {
      ...automation.definition,
      nodes: automation.definition.nodes.map((node) => ({
        ...node,
        position: positions.get(node.id) ?? node.position,
      })),
    },
  };
}

function replaceSummary(items: AutomationSummary[], updated: AutomationSummary): AutomationSummary[] {
  return items.map((item) => (item.id === updated.id ? updated : item));
}

export function AutomationsView() {
  const autosaveTimerRef = useRef<number | null>(null);
  const layoutSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const layoutSequenceRef = useRef(0);
  const pendingLayoutSavesRef = useRef(0);
  const [section, setSection] = useState<Section>("flows");
  const [items, setItems] = useState<AutomationSummary[]>([]);
  const [apps, setApps] = useState<ConnectedAppSummary[]>([]);
  const [notificationRecipients, setNotificationRecipients] = useState<TicketAssigneeDto[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [persisted, setPersisted] = useState<AutomationDetail | null>(null);
  const [draft, setDraft] = useState<AutomationDetail | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [appsLoading, setAppsLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [metadataSaving, setMetadataSaving] = useState(false);
  const [layoutSaving, setLayoutSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [flowBusy, setFlowBusy] = useState(false);
  const [testRunning, setTestRunning] = useState(false);
  const [dryRun, setDryRun] = useState<AutomationExecution | null>(null);
  const [dryRunError, setDryRunError] = useState<string | null>(null);
  const [dryRunOpen, setDryRunOpen] = useState(false);
  const [autosaveStatus, setAutosaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [appBusyId, setAppBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [appsError, setAppsError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  const catalog = useMemo(
    () => catalogWithConnectedApps(apps, notificationRecipients),
    [apps, notificationRecipients],
  );
  const issues = useMemo(
    () => validateAutomation(draft?.definition ?? emptyDefinition, catalog),
    [catalog, draft?.definition],
  );
  const errors = issues.filter((issue) => issue.severity === "error");
  const functionalDirty = editableAutomationSignature(draft) !== editableAutomationSignature(persisted);
  const metadataDirty = automationMetadataSignature(draft) !== automationMetadataSignature(persisted);
  const dirty = functionalDirty || metadataDirty;
  const draftSignature = editableAutomationSignature(draft);
  const persistedSignature = editableAutomationSignature(persisted);
  const selectedNode = draft?.definition.nodes.find((node) => node.id === selectedNodeId) ?? null;
  const selectedNodeDefinition = selectedNode
    ? automationNodeDefinition(automationNodeCatalogId(selectedNode), catalog)
    : null;

  const showNotice = useCallback((next: NonNullable<Notice>) => {
    setNotice(next);
    window.setTimeout(() => setNotice(null), 3_500);
  }, []);

  const persistFlow = useCallback(async (
    snapshot: AutomationDetail,
    options: { notify?: boolean } = {},
  ): Promise<AutomationDetail | null> => {
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    const signature = editableAutomationSignature(snapshot);
    setSaving(true);
    setAutosaveStatus("saving");
    try {
      const updated = await updateAutomation(snapshot.id, {
        name: snapshot.name.trim(),
        description: snapshot.description?.trim() || null,
        definition: snapshot.definition,
      });
      setPersisted((current) => (current?.id === updated.id ? updated : current));
      setDraft((current) => {
        if (current?.id !== updated.id) return current;
        if (editableAutomationSignature(current) !== signature) return current;
        return {
          ...structuredClone(updated),
          name: current.name,
          description: current.description,
        };
      });
      setItems((current) => replaceSummary(current, updated));
      setAutosaveStatus("saved");
      if (options.notify) {
        showNotice({ tone: "success", message: "Fluxo salvo no SQLite." });
      }
      return updated;
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : "Não foi possível salvar o fluxo.";
      setAutosaveStatus("error");
      showNotice({ tone: "warning", message });
      return null;
    } finally {
      setSaving(false);
    }
  }, [showNotice]);

  const persistMetadata = useCallback(async (
    snapshot: AutomationDetail,
    options: { notify?: boolean } = {},
  ): Promise<AutomationDetail | null> => {
    const signature = automationMetadataSignature(snapshot);
    setMetadataSaving(true);
    setAutosaveStatus("saving");
    try {
      const updated = await updateAutomationMetadata(snapshot.id, {
        name: snapshot.name.trim(),
        description: snapshot.description?.trim() || null,
      });
      setPersisted((current) => (current?.id === updated.id ? updated : current));
      setDraft((current) => {
        if (current?.id !== updated.id) return current;
        if (automationMetadataSignature(current) !== signature) return current;
        return {
          ...current,
          name: updated.name,
          description: updated.description,
          status: updated.status,
          updatedAt: updated.updatedAt,
        };
      });
      setItems((current) => replaceSummary(current, updated));
      setAutosaveStatus("saved");
      if (options.notify) {
        showNotice({ tone: "success", message: "Nome e descrição salvos no SQLite." });
      }
      return updated;
    } catch (saveError) {
      const message = saveError instanceof Error
        ? saveError.message
        : "Não foi possível salvar o nome e a descrição.";
      setAutosaveStatus("error");
      showNotice({ tone: "warning", message });
      return null;
    } finally {
      setMetadataSaving(false);
    }
  }, [showNotice]);

  const loadApps = useCallback(async () => {
    setAppsLoading(true);
    try {
      const response = await listConnectedApps();
      setApps(response.items);
      setAppsError(null);
    } catch (loadError) {
      setApps([]);
      setAppsError(loadError instanceof Error ? loadError.message : "Não foi possível carregar os apps conectados.");
    } finally {
      setAppsLoading(false);
    }
  }, []);

  const loadFlows = useCallback(async () => {
    setLoading(true);
    try {
      const response = await listAutomations();
      setItems(response.items);
      if (!response.items.length) {
        setPersisted(null);
        setDraft(null);
      }
      setSelectedId((current) =>
        current && response.items.some((item) => item.id === current)
          ? current
          : response.items[0]?.id ?? null,
      );
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Não foi possível carregar as automações.");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadNotificationRecipients = useCallback(async () => {
    try {
      setNotificationRecipients(await listNotificationRecipients());
    } catch {
      setNotificationRecipients([]);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void Promise.allSettled([loadFlows(), loadApps(), loadNotificationRecipients()]);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadApps, loadFlows, loadNotificationRecipients]);

  useEffect(() => () => {
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current);
    }
  }, []);

  useEffect(() => {
    if (
      !draft ||
      !persisted ||
      draft.id !== persisted.id ||
      draftSignature === persistedSignature ||
      saving ||
      creating ||
      !draft.name.trim()
    ) {
      return;
    }

    const snapshot = structuredClone(draft);
    autosaveTimerRef.current = window.setTimeout(() => {
      autosaveTimerRef.current = null;
      void persistFlow(snapshot);
    }, 350);
    return () => {
      if (autosaveTimerRef.current !== null) {
        window.clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
    };
  }, [
    creating,
    draft,
    draftSignature,
    persisted,
    persistedSignature,
    persistFlow,
    saving,
  ]);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setDetailLoading(true);
      void getAutomation(selectedId)
        .then((automation) => {
          if (cancelled) return;
          setPersisted(automation);
          setDraft(structuredClone(automation));
          setSelectedNodeId(null);
          setDryRun(null);
          setDryRunError(null);
          setDryRunOpen(false);
          setAutosaveStatus("saved");
          setError(null);
        })
        .catch((loadError) => {
          if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Não foi possível abrir o fluxo.");
        })
        .finally(() => {
          if (!cancelled) setDetailLoading(false);
        });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [selectedId]);

  function changeDefinition(
    definition: AutomationDefinition,
    options: { persistImmediately?: boolean } = {},
  ) {
    setDraft((current) => (current ? { ...current, definition } : current));
    setDryRun(null);
    setDryRunError(null);
    setDryRunOpen(false);
    if (options.persistImmediately && draft) {
      void persistFlow({ ...structuredClone(draft), definition });
    }
  }

  function openNodeConfiguration(nodeId: string) {
    setSelectedNodeId(nodeId);
    setConfigOpen(true);
  }

  function changeConfigOpen(open: boolean) {
    setConfigOpen(open);
  }

  function changeLayout(nodes: AutomationLayoutNode[]) {
    if (!draft) return;
    const workflowId = draft.id;
    const sequence = ++layoutSequenceRef.current;
    setDraft((current) =>
      current?.id === workflowId ? automationWithLayout(current, nodes) : current,
    );
    setPersisted((current) =>
      current?.id === workflowId ? automationWithLayout(current, nodes) : current,
    );
    pendingLayoutSavesRef.current += 1;
    setLayoutSaving(true);
    setAutosaveStatus("saving");
    layoutSaveQueueRef.current = layoutSaveQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        try {
          const updated = await updateAutomationLayout(workflowId, { nodes });
          if (sequence !== layoutSequenceRef.current) return;
          setDraft((current) =>
            current?.id === workflowId
              ? automationWithLayout(current, updated.definition.nodes)
              : current,
          );
          setPersisted((current) =>
            current?.id === workflowId
              ? automationWithLayout(current, updated.definition.nodes)
              : current,
          );
          setItems((current) => replaceSummary(current, updated));
          setAutosaveStatus("saved");
        } catch (layoutError) {
          if (sequence !== layoutSequenceRef.current) return;
          setAutosaveStatus("error");
          showNotice({
            tone: "warning",
            message: layoutError instanceof Error
              ? layoutError.message
              : "Não foi possível salvar a disposição dos nós.",
          });
        } finally {
          pendingLayoutSavesRef.current -= 1;
          if (pendingLayoutSavesRef.current === 0) setLayoutSaving(false);
        }
      });
  }

  function addNode(catalogId: string, position?: { x: number; y: number }) {
    if (!draft) return;
    const definition = automationNodeDefinition(catalogId, catalog);
    if (!definition || definition.connected === false) return;
    const index = draft.definition.nodes.length;
    const node: AutomationNodeDto = {
      id: `node-${crypto.randomUUID()}`,
      type: definition.nodeType,
      position: position ?? {
        x: 80 + (index % 3) * 300,
        y: 80 + Math.floor(index / 3) * 190,
      },
      config: initialNodeConfig(definition),
    };
    changeDefinition(
      { ...draft.definition, nodes: [...draft.definition.nodes, node] },
      { persistImmediately: true },
    );
    setSelectedNodeId(node.id);
  }

  function updateNode(updated: AutomationNodeDto) {
    if (!draft) return;
    changeDefinition({
      ...draft.definition,
      nodes: draft.definition.nodes.map((node) => (node.id === updated.id ? updated : node)),
    });
  }

  function removeNode(nodeId: string) {
    if (!draft) return;
    changeDefinition(
      {
        ...draft.definition,
        nodes: draft.definition.nodes.filter((node) => node.id !== nodeId),
        edges: draft.definition.edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId),
      },
      { persistImmediately: true },
    );
    changeConfigOpen(false);
    setSelectedNodeId(null);
  }

  async function saveFlow(options: { notify?: boolean } = { notify: true }): Promise<AutomationDetail | null> {
    if (!draft) return null;
    if (functionalDirty) return persistFlow(structuredClone(draft), options);
    if (metadataDirty) return persistMetadata(structuredClone(draft), options);
    return draft;
  }

  function saveMetadataOnBlur() {
    if (!draft || !metadataDirty || metadataSaving || !draft.name.trim()) return;
    void persistMetadata(structuredClone(draft));
  }

  async function createFlow() {
    if (!createName.trim()) return;
    setCreating(true);
    try {
      const created = await createAutomation({
        name: createName.trim(),
        description: createDescription.trim() || null,
      });
      setItems((current) => [created, ...current]);
      setSelectedId(created.id);
      setPersisted(created);
      setDraft(structuredClone(created));
      setAutosaveStatus("saved");
      setCreateName("");
      setCreateDescription("");
      setCreateOpen(false);
      showNotice({ tone: "success", message: "Rascunho criado. Adicione um gatilho para começar." });
    } catch (createError) {
      showNotice({ tone: "warning", message: createError instanceof Error ? createError.message : "Não foi possível criar o fluxo." });
    } finally {
      setCreating(false);
    }
  }

  async function activate() {
    if (!draft || dirty || errors.length) return;
    setFlowBusy(true);
    try {
      const updated = await activateAutomation(draft.id);
      setItems((current) => replaceSummary(current, updated));
      setDraft((current) => (current ? { ...current, status: updated.status } : current));
      setPersisted((current) => (current ? { ...current, status: updated.status } : current));
      showNotice({ tone: "success", message: "Fluxo ativado. Novos eventos já podem iniciar execuções." });
    } catch (activateError) {
      showNotice({ tone: "warning", message: activateError instanceof Error ? activateError.message : "Não foi possível ativar." });
    } finally {
      setFlowBusy(false);
    }
  }

  async function pause() {
    if (!draft) return;
    setFlowBusy(true);
    try {
      const updated = await pauseAutomation(draft.id);
      setItems((current) => replaceSummary(current, updated));
      setDraft((current) => (current ? { ...current, status: updated.status } : current));
      setPersisted((current) => (current ? { ...current, status: updated.status } : current));
      showNotice({ tone: "success", message: "Fluxo pausado. Execuções persistidas continuam auditáveis." });
    } catch (pauseError) {
      showNotice({ tone: "warning", message: pauseError instanceof Error ? pauseError.message : "Não foi possível pausar." });
    } finally {
      setFlowBusy(false);
    }
  }

  async function runTest() {
    if (!draft || errors.length) return;
    setFlowBusy(true);
    setTestRunning(true);
    setDryRunOpen(true);
    setDryRun(null);
    setDryRunError(null);
    try {
      const saved = dirty ? await saveFlow({ notify: false }) : draft;
      if (!saved) return;
      const execution = await testAutomation(saved.id);
      setDryRun(execution);
      setItems((current) => current.map((item) => (
        item.id === saved.id
          ? { ...item, runCount: item.runCount + 1, lastRunAt: execution.startedAt }
          : item
      )));
      setDraft((current) => (
        current?.id === saved.id
          ? { ...current, runCount: current.runCount + 1, lastRunAt: execution.startedAt }
          : current
      ));
      setPersisted((current) => (
        current?.id === saved.id
          ? { ...current, runCount: current.runCount + 1, lastRunAt: execution.startedAt }
          : current
      ));
      showNotice({
        tone: "success",
        message: "Dry Run concluído no canvas, sem executar nenhuma ação.",
      });
    } catch (testError) {
      const message = testError instanceof Error ? testError.message : "Não foi possível testar.";
      setDryRunError(message);
      showNotice({ tone: "warning", message });
    } finally {
      setFlowBusy(false);
      setTestRunning(false);
    }
  }

  async function removeFlow() {
    if (!draft) return;
    setFlowBusy(true);
    try {
      await deleteAutomation(draft.id);
      const remaining = items.filter((item) => item.id !== draft.id);
      setItems(remaining);
      setSelectedId(remaining[0]?.id ?? null);
      if (!remaining.length) {
        setPersisted(null);
        setDraft(null);
      }
      setDeleteOpen(false);
      showNotice({ tone: "success", message: "Fluxo excluído." });
    } catch (deleteError) {
      showNotice({ tone: "warning", message: deleteError instanceof Error ? deleteError.message : "Não foi possível excluir." });
    } finally {
      setFlowBusy(false);
    }
  }

  async function saveApp(input: UpsertConnectedAppInput, id?: string) {
    try {
      const updated = id
        ? await updateConnectedApp(id, input)
        : await createConnectedApp(input);
      setApps((current) => id
        ? current.map((app) => (app.id === updated.id ? updated : app))
        : [updated, ...current]);
      showNotice({ tone: "success", message: id ? "Conexão atualizada." : "App conectado com segurança." });
    } catch (appError) {
      showNotice({ tone: "warning", message: appError instanceof Error ? appError.message : "Não foi possível salvar o app." });
      throw appError;
    }
  }

  async function testApp(app: ConnectedAppSummary) {
    setAppBusyId(app.id);
    try {
      const result = await testConnectedApp(app.id);
      showNotice({ tone: result.ok ? "success" : "warning", message: result.message });
      await loadApps();
    } catch (appError) {
      showNotice({ tone: "warning", message: appError instanceof Error ? appError.message : "O teste falhou." });
    } finally {
      setAppBusyId(null);
    }
  }

  async function removeApp(app: ConnectedAppSummary) {
    setAppBusyId(app.id);
    try {
      await deleteConnectedApp(app.id);
      setApps((current) => current.filter((item) => item.id !== app.id));
      showNotice({ tone: "success", message: "Conexão excluída." });
    } catch (appError) {
      showNotice({ tone: "warning", message: appError instanceof Error ? appError.message : "Não foi possível excluir o app." });
    } finally {
      setAppBusyId(null);
    }
  }

  return (
    <Tabs className="min-h-full min-w-0 gap-0 overflow-x-hidden" onValueChange={(value) => setSection(value as Section)} value={section}>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-b bg-card px-4 py-2.5">
        <TabsList className="max-w-full overflow-x-auto">
          <TabsTrigger value="flows"><Workflow size={14} /> Fluxos</TabsTrigger>
          <TabsTrigger value="apps">Apps conectados <Badge variant="secondary">{apps.length}</Badge></TabsTrigger>
        </TabsList>
        {notice ? (
          <div className={cn("flex min-w-0 items-center gap-2 text-xs", notice.tone === "success" ? "text-emerald-700" : "text-amber-700")} role="status">
            {notice.tone === "success" ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
            <span className="max-w-md truncate">{notice.message}</span>
          </div>
        ) : null}
      </div>

      <TabsContent className="m-0 min-h-0 min-w-0" value="flows">
        {error ? (
          <div className="mx-4 mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-xs text-destructive">
            <AlertTriangle size={15} /> <span className="min-w-0 flex-1 break-words">{error}</span>
            <Button onClick={() => void loadFlows()} size="sm" type="button" variant="outline">Tentar novamente</Button>
          </div>
        ) : null}
        <div className="grid min-h-[calc(100dvh-155px)] min-w-0 grid-cols-[280px_minmax(0,1fr)] gap-3 p-3 max-[900px]:grid-cols-1">
          <AutomationList items={items} loading={loading} onCreate={() => setCreateOpen(true)} onSelect={setSelectedId} selectedId={selectedId} />
          <Card className="min-h-0 min-w-0 gap-0 overflow-hidden p-0">
            {detailLoading ? <div className="grid min-h-[500px] place-items-center text-sm text-muted-foreground"><span className="flex items-center gap-2"><LoaderCircle className="animate-spin" size={17} /> Abrindo fluxo…</span></div> : null}
            {!detailLoading && !draft ? (
              <div className="grid min-h-[500px] place-items-center content-center gap-2 p-8 text-center">
                <Workflow className="text-muted-foreground" size={28} />
                <h2 className="text-sm font-semibold">Selecione ou crie um fluxo</h2>
                <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">Combine gatilhos, esperas, decisões e ações autorizadas.</p>
                <Button className="mt-2" onClick={() => setCreateOpen(true)} size="sm" type="button"><Plus size={14} /> Novo fluxo</Button>
              </div>
            ) : null}
            {!detailLoading && draft ? (
              <>
                <header className="flex flex-wrap items-start gap-3 border-b p-3">
                  <div className="min-w-[220px] flex-1">
                    <Input
                      aria-label="Nome do fluxo"
                      className="h-7 border-transparent px-1 text-base font-semibold shadow-none hover:border-input focus-visible:border-ring"
                      maxLength={120}
                      onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                      onBlur={saveMetadataOnBlur}
                      value={draft.name}
                    />
                    <Input
                      aria-label="Descrição do fluxo"
                      className="mt-1 h-6 border-transparent px-1 text-xs text-muted-foreground shadow-none hover:border-input focus-visible:border-ring"
                      maxLength={300}
                      onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                      onBlur={saveMetadataOnBlur}
                      placeholder="Descreva o objetivo desta automação"
                      value={draft.description ?? ""}
                    />
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <Badge
                      className={cn(
                        draft.status === "active" && "border-emerald-200 bg-emerald-100 text-emerald-800",
                        draft.status === "draft" && "border-amber-200 bg-amber-50 text-amber-800",
                        draft.status === "paused" && "border-blue-200 bg-blue-50 text-blue-800",
                      )}
                      variant="outline"
                    >
                      <span className={cn(
                        "mr-1.5 size-1.5 rounded-full bg-muted-foreground",
                        draft.status === "active" && "bg-emerald-600",
                        draft.status === "draft" && "bg-amber-500",
                        draft.status === "paused" && "bg-blue-500",
                      )} />
                      {draft.status === "active" ? "Ativa" : draft.status === "paused" ? "Pausada" : "Rascunho"}
                    </Badge>
                    <Button onClick={() => setCatalogOpen(true)} size="sm" type="button" variant="outline"><Plus size={14} /> Adicionar etapa</Button>
                    <span className={cn("text-2xs", autosaveStatus === "error" ? "text-destructive" : "text-muted-foreground")} role="status">
                      {saving || metadataSaving || layoutSaving || autosaveStatus === "saving"
                        ? "Salvando no SQLite…"
                        : dirty
                          ? "Salvamento automático pendente"
                          : autosaveStatus === "error"
                            ? "Falha ao salvar"
                            : "Salvo no SQLite"}
                    </span>
                    <Button disabled={!dirty || saving || metadataSaving || !draft.name.trim()} onClick={() => void saveFlow()} size="sm" type="button" variant="outline">{saving || metadataSaving ? <LoaderCircle className="animate-spin" size={14} /> : <Save size={14} />} Salvar agora</Button>
                    <Button disabled={flowBusy || saving || metadataSaving || errors.length > 0} onClick={() => void runTest()} size="sm" title={errors[0]?.message} type="button" variant="outline">{testRunning ? <LoaderCircle className="animate-spin" size={14} /> : <FlaskConical size={14} />} Dry Run</Button>
                    {draft.status === "active" ? (
                      <Button disabled={flowBusy} onClick={() => void pause()} size="sm" type="button" variant="outline"><CirclePause size={14} /> Pausar</Button>
                    ) : (
                      <Button disabled={flowBusy || dirty || errors.length > 0} onClick={() => void activate()} size="sm" title={dirty ? "Salve o fluxo antes de ativar" : errors[0]?.message} type="button">Ativar</Button>
                    )}
                    <Button aria-label="Excluir fluxo" disabled={flowBusy} onClick={() => setDeleteOpen(true)} size="icon-sm" type="button" variant="destructive"><Trash2 size={14} /></Button>
                  </div>
                </header>
                {issues.length ? (
                  <div className={cn("flex max-h-24 flex-wrap items-center gap-x-3 gap-y-1 overflow-y-auto border-b px-3 py-2 text-xs", errors.length ? "bg-amber-50 text-amber-900" : "bg-muted/50 text-muted-foreground")}>
                    <strong className="flex items-center gap-1.5"><AlertTriangle size={14} /> {errors.length ? `${errors.length} ajuste(s) antes de ativar` : "Fluxo válido com avisos"}</strong>
                    {issues.slice(0, 3).map((issue) => (
                      <span key={issue.id}>{issue.message}</span>
                    ))}
                  </div>
                ) : (
                  <div className="flex items-center gap-2 border-b bg-emerald-50 px-3 py-2 text-xs text-emerald-800"><CheckCircle2 size={14} /> Fluxo válido e pronto para ativar.</div>
                )}
                <div className="min-h-0 flex-1 p-3">
                  <AutomationCanvas
                    catalog={catalog}
                    definition={draft.definition}
                    dryRun={dryRun}
                    dryRunError={dryRunError}
                    dryRunOpen={dryRunOpen}
                    dryRunRunning={testRunning}
                    issues={issues}
                    onAddNode={addNode}
                    onChange={changeDefinition}
                    onCloseDryRun={() => setDryRunOpen(false)}
                    onConfigureNode={(nodeId) => openNodeConfiguration(nodeId)}
                    onLayoutChange={changeLayout}
                    onRemoveNode={removeNode}
                    onRunDryRun={() => void runTest()}
                    onSelectNode={setSelectedNodeId}
                    selectedNodeId={selectedNodeId}
                  />
                </div>
              </>
            ) : null}
          </Card>
        </div>
      </TabsContent>

      <TabsContent className="m-0 min-w-0" value="apps">
        <ConnectedAppsPanel apps={apps} busyId={appBusyId} error={appsError} loading={appsLoading} onDelete={removeApp} onRetry={() => void loadApps()} onSave={saveApp} onTest={testApp} />
      </TabsContent>
      <NodeCatalogSheet
        catalog={catalog}
        onAdd={addNode}
        onOpenApps={() => { setCatalogOpen(false); setSection("apps"); }}
        onOpenChange={setCatalogOpen}
        open={catalogOpen}
      />
      <NodeConfigSheet
        definition={selectedNodeDefinition}
        issues={issues}
        node={selectedNode}
        onChange={updateNode}
        onDelete={removeNode}
        onOpenChange={changeConfigOpen}
        open={configOpen}
      />

      <Dialog onOpenChange={setCreateOpen} open={createOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Novo fluxo</DialogTitle>
            <DialogDescription>Crie o rascunho primeiro e monte as etapas no canvas.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <label className="grid gap-1.5 text-xs font-medium">Nome<Input autoFocus maxLength={120} onChange={(event) => setCreateName(event.target.value)} placeholder="Ex.: Encaminhar bugs urgentes" value={createName} /></label>
            <label className="grid gap-1.5 text-xs font-medium">Descrição<Textarea className="min-h-20" maxLength={300} onChange={(event) => setCreateDescription(event.target.value)} placeholder="O que este fluxo organiza?" value={createDescription} /></label>
          </div>
          <DialogFooter>
            <Button disabled={creating} onClick={() => setCreateOpen(false)} type="button" variant="outline">Cancelar</Button>
            <Button disabled={creating || !createName.trim()} onClick={() => void createFlow()} type="button">{creating ? <LoaderCircle className="animate-spin" size={14} /> : null} Criar fluxo</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog onOpenChange={setDeleteOpen} open={deleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir este fluxo?</AlertDialogTitle>
            <AlertDialogDescription>O histórico de execuções deve permanecer auditável conforme as regras do servidor.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => void removeFlow()} variant="destructive">Excluir fluxo</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Tabs>
  );
}
