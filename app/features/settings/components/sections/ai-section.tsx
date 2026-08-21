"use client";

import { Input } from "@/app/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@/app/components/ui/input-group";
import { Checkbox } from "@/app/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/app/components/ui/select";
import { Bot, CheckCircle2, CircleAlert, Cloud, Laptop, LoaderCircle, Plus, RefreshCw, Save, Settings2, Trash2, X } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createAiConnection, deleteAiConnection, getAiTaskProfiles, testAiConnection, updateAiConnection, updateAiTaskProfiles, type AiConnection, type AiProviderId, type AiTaskProfile, type WriteAiConnectionInput } from "@/app/lib/settings";
import { connectionSupportsTask } from "@/app/lib/ai-task-capabilities";
import { aiTaskProfilesMatch } from "@/app/lib/ai-profile-state";
import { updateTriageAiSettings } from "@/app/lib/api";
import type { TriageAiSettingsDto } from "@/shared/contracts";
import { Button } from "@/app/components/ui/button";
import { Card } from "@/app/components/ui/card";
import { PROVIDERS, TASKS, inputClass, MANUAL_MODEL_VALUE, type ModelCatalogState, SectionLayout, Field, PermissionNotice, EmptySettingsState, Capability, TaskSecurityNote, providerMeta, getModelSuggestions, emptyConnectionDraft, connectionDraft, emptyProfile, completeProfiles, updateProfileDraft, errorMessage } from "../settings-support";
import { AudioTranscriptionSection } from "../audio-transcription-section";

const NO_CONNECTION_VALUE = "__threadmark_no_connection__";

type ConnectionDraft = {
  id: string | null;
  label: string;
  providerId: AiProviderId;
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
  hasSecret: boolean;
};

export function AiSection({
  connections,
  profiles,
  triageSettings,
  canManage,
  onConnectionsChange,
  onDirtyChange,
  onProfilesChange,
  onTriageSettingsChange,
  onFeedback,
}: {
  connections: AiConnection[];
  profiles: AiTaskProfile[];
  triageSettings: TriageAiSettingsDto | null;
  canManage: boolean;
  onConnectionsChange(value: AiConnection[]): void;
  onDirtyChange(value: boolean): void;
  onProfilesChange(value: AiTaskProfile[]): void;
  onTriageSettingsChange(value: TriageAiSettingsDto): void;
  onFeedback(tone: "success" | "error", message: string): void;
}) {
  const [editor, setEditor] = useState<ConnectionDraft | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [modelCatalogs, setModelCatalogs] = useState<Record<string, ModelCatalogState>>({});
  const [profileDrafts, setProfileDrafts] = useState(() => completeProfiles(profiles));
  const [silenceWindowMinutes, setSilenceWindowMinutes] = useState(() =>
    String((triageSettings?.silenceWindowSeconds ?? 180) / 60),
  );
  const [savingProfiles, setSavingProfiles] = useState(false);
  const [savedNow, setSavedNow] = useState(false);
  const discoveryRequests = useRef(new Map<string, Promise<void>>());

  const profilesDirty = useMemo(
    () => !aiTaskProfilesMatch(profileDrafts, profiles),
    [profileDrafts, profiles],
  );
  const silenceWindowSeconds = Math.round(Number(silenceWindowMinutes) * 60);
  const silenceWindowInvalid =
    !Number.isFinite(silenceWindowSeconds) ||
    silenceWindowSeconds < 30 ||
    silenceWindowSeconds > 1_800;
  const silenceWindowDirty = Boolean(
    triageSettings &&
      !silenceWindowInvalid &&
      silenceWindowSeconds !== triageSettings.silenceWindowSeconds,
  );
  const triageProfileDraft = profileDrafts.find(
    (profile) => profile.taskKind === "triage",
  );
  const triageRuntimeDirty = Boolean(
    triageSettings &&
      triageProfileDraft &&
      (triageProfileDraft.enabled !== triageSettings.enabled ||
        (triageProfileDraft.model.trim() || "default") !== triageSettings.model),
  );
  const aiSettingsDirty = profilesDirty || silenceWindowDirty;

  const discoverModels = useCallback((connection: AiConnection): Promise<void> => {
    const activeRequest = discoveryRequests.current.get(connection.id);
    if (activeRequest) return activeRequest;
    setModelCatalogs((current) => ({
      ...current,
      [connection.id]: {
        status: "loading",
        models: current[connection.id]?.models ?? [],
        message: "Carregando modelos disponíveis…",
      },
    }));
    const request = testAiConnection(connection.id)
      .then((result) => {
        setModelCatalogs((current) => ({
          ...current,
          [connection.id]: {
            status: "success",
            models: result.models ?? [],
            message: result.message,
          },
        }));
      })
      .catch((cause: unknown) => {
        setModelCatalogs((current) => ({
          ...current,
          [connection.id]: {
            status: "error",
            models: current[connection.id]?.models ?? [],
            message: errorMessage(cause),
          },
        }));
      })
      .finally(() => {
        discoveryRequests.current.delete(connection.id);
      });
    discoveryRequests.current.set(connection.id, request);
    return request;
  }, []);

  const automaticallyDiscoveredConnections = useMemo(() => {
    const selectedIds = new Set(profileDrafts.map((profile) => profile.connectionId));
    return connections.filter(
      (connection) => connection.enabled || selectedIds.has(connection.id),
    );
  }, [connections, profileDrafts]);

  useEffect(() => {
    for (const connection of automaticallyDiscoveredConnections) {
      if (!modelCatalogs[connection.id]) void discoverModels(connection);
    }
  }, [automaticallyDiscoveredConnections, discoverModels, modelCatalogs]);

  useEffect(() => {
    onDirtyChange(aiSettingsDirty);
  }, [aiSettingsDirty, onDirtyChange]);

  useEffect(
    () => () => onDirtyChange(false),
    [onDirtyChange],
  );

  async function saveConnection(event: FormEvent) {
    event.preventDefault();
    if (!editor) return;
    setBusyId(editor.id ?? "new");
    const provider = providerMeta(editor.providerId);
    const input: WriteAiConnectionInput = {
      label: editor.label.trim(),
      providerId: editor.providerId,
      enabled: editor.enabled,
      ...(provider.supportsBaseUrl ? { baseUrl: editor.baseUrl.trim() || null } : {}),
      ...(editor.apiKey.trim() ? { apiKey: editor.apiKey.trim() } : {}),
    };
    try {
      const saved = editor.id ? await updateAiConnection(editor.id, input) : await createAiConnection(input);
      onConnectionsChange(editor.id ? connections.map((item) => item.id === saved.id ? saved : item) : [...connections, saved]);
      setEditor(null);
      onFeedback("success", `${saved.label} foi salva. Nenhuma credencial será exibida pela API.`);
    } catch (cause) {
      onFeedback("error", errorMessage(cause));
    } finally {
      setBusyId(null);
    }
  }

  async function removeConnection(connection: AiConnection) {
    if (!window.confirm(`Excluir a conexão “${connection.label}”? Perfis que dependem dela precisarão ser reconfigurados.`)) return;
    setBusyId(connection.id);
    try {
      await deleteAiConnection(connection.id);
      onConnectionsChange(connections.filter((item) => item.id !== connection.id));
      const refreshedProfiles = await getAiTaskProfiles();
      setProfileDrafts(completeProfiles(refreshedProfiles));
      onProfilesChange(refreshedProfiles);
      onFeedback("success", "A conexão e a credencial associada foram removidas.");
    } catch (cause) {
      onFeedback("error", errorMessage(cause));
    } finally {
      setBusyId(null);
    }
  }

  async function saveProfiles() {
    setSavingProfiles(true);
    try {
      if (profilesDirty) {
        const saved = await updateAiTaskProfiles(profileDrafts.map(({ taskKind, connectionId, model, enabled }) => ({
          taskKind,
          connectionId,
          model: model.trim() || "default",
          enabled,
        })));
        setProfileDrafts(completeProfiles(saved));
        onProfilesChange(saved);
      }
      if ((silenceWindowDirty || triageRuntimeDirty) && triageSettings) {
        const savedTriageSettings = await updateTriageAiSettings({
          enabled: triageProfileDraft?.enabled ?? triageSettings.enabled,
          model: triageProfileDraft?.model.trim() || triageSettings.model,
          silenceWindowSeconds,
        });
        setSilenceWindowMinutes(String(savedTriageSettings.silenceWindowSeconds / 60));
        onTriageSettingsChange(savedTriageSettings);
      }
      setSavedNow(true);
      onFeedback("success", "Os modelos e o tempo de agrupamento da triagem foram atualizados.");
    } catch (cause) {
      onFeedback("error", errorMessage(cause));
    } finally {
      setSavingProfiles(false);
    }
  }

  const profilesInvalid = profileDrafts.some(
    (profile) => {
      if (!profile.enabled) return false;
      const connection = connections.find((item) => item.id === profile.connectionId);
      return !connection || !profile.model.trim() || !connectionSupportsTask(connection, profile.taskKind);
    },
  );
  const aiSettingsInvalid = profilesInvalid || silenceWindowInvalid;

  const actionBarFloating = aiSettingsDirty || savingProfiles;

  return (
    <div className={`space-y-6 ${actionBarFloating ? "pb-28" : ""}`}>
      <SectionLayout
        action={canManage && !editor ? <Button onClick={() => setEditor(emptyConnectionDraft())} size="sm" type="button" variant="default"><Plus size={16} /> Nova conexão</Button> : null}
        description="Conecte provedores usando suas próprias contas. Chaves são write-only."
        icon={Bot}
        title="Conexões de IA"
      >
        {!canManage ? <PermissionNotice /> : null}
        {editor ? (
          <ConnectionEditor busy={busyId === (editor.id ?? "new")} draft={editor} onCancel={() => setEditor(null)} onChange={setEditor} onSubmit={saveConnection} />
        ) : null}
        <div className={`grid gap-4 ${connections.length > 1 ? "xl:grid-cols-2" : ""}`}>
          {connections.length === 0 ? (
            <div className="xl:col-span-2"><EmptySettingsState description={canManage ? "Adicione o Codex CLI, um provedor de nuvem ou um modelo local." : "Somente proprietários e administradores podem consultar conexões."} icon={Bot} title={canManage ? "Nenhuma conexão configurada" : "Acesso restrito"} /></div>
          ) : connections.map((connection) => {
            const provider = providerMeta(connection.providerId);
            const catalog = modelCatalogs[connection.id];
            return (
              <Card className="gap-0 p-5" key={connection.id}>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 gap-3">
                    <span className={`grid size-10 shrink-0 place-items-center rounded-xl ${connection.providerId === "ollama" || connection.providerId === "codex" ? "bg-emerald-50 text-emerald-700" : "bg-blue-50 text-blue-700"}`}>{connection.providerId === "ollama" || connection.providerId === "codex" ? <Laptop size={18} /> : <Cloud size={18} />}</span>
                    <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="truncate font-semibold text-foreground">{connection.label}</h3><span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${connection.enabled ? "bg-emerald-50 text-emerald-700" : "bg-muted text-muted-foreground"}`}>{connection.enabled ? "Ativa" : "Pausada"}</span></div><p className="mt-1 text-xs text-muted-foreground">{provider.label}{connection.hasSecret ? " · Credencial protegida" : provider.requiresSecret ? " · Credencial pendente" : " · Sem chave de API"}</p></div>
                  </div>
                  {canManage ? <Button aria-label={`Editar ${connection.label}`} onClick={() => setEditor(connectionDraft(connection))} size="sm" type="button" variant="ghost">Editar</Button> : null}
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  {connection.capabilities.vision ? <Capability label="Imagens" /> : null}
                  {connection.capabilities.structuredOutput ? <Capability label="Saída estruturada" /> : null}
                  {connection.capabilities.triage ? <Capability label="Sugestões de ticket" /> : null}
                  {connection.capabilities.localTools ? <Capability label="Ferramentas locais" /> : null}
                  {connection.capabilities.codebaseAccess ? <Capability label="Codebase" /> : null}
                  {connection.capabilities.deepInvestigation ? <Capability label="Threadmark AI" /> : null}
                </div>
                {connection.baseUrl ? <p className="mt-4 truncate rounded-lg bg-muted px-3 py-2 font-mono text-xs text-muted-foreground">{connection.baseUrl}</p> : null}
                {catalog ? <p className={`mt-4 flex items-start gap-2 rounded-xl px-3 py-2 text-xs ${catalog.status === "error" ? "bg-destructive/10 text-destructive" : catalog.status === "success" ? "bg-emerald-50 text-emerald-800" : "bg-muted text-muted-foreground"}`}>{catalog.status === "loading" ? <LoaderCircle className="mt-0.5 shrink-0 animate-spin" size={14} /> : catalog.status === "success" ? <CheckCircle2 className="mt-0.5 shrink-0" size={14} /> : <CircleAlert className="mt-0.5 shrink-0" size={14} />}<span>{catalog.message}{catalog.status === "success" && catalog.models.length ? ` ${catalog.models.length} modelo(s) disponível(is) para seleção.` : ""}</span></p> : null}
                {canManage ? <div className="mt-5 flex flex-wrap gap-2 border-t border-border pt-4"><Button disabled={catalog?.status === "loading"} onClick={() => void discoverModels(connection)} size="sm" type="button" variant="outline">{catalog?.status === "loading" ? <LoaderCircle className="animate-spin" size={14} /> : <RefreshCw size={14} />} {connection.providerId === "codex" ? "Testar Codex CLI" : "Testar e buscar modelos"}</Button>{connection.id !== "builtin-codex" ? <Button aria-label={`Excluir ${connection.label}`} disabled={busyId === connection.id} onClick={() => void removeConnection(connection)} size="icon-sm" type="button" variant="destructive"><Trash2 size={14} /></Button> : null}</div> : null}
              </Card>
            );
          })}
        </div>
      </SectionLayout>

      <SectionLayout description="Escolha uma conexão e um modelo para cada parte do fluxo." icon={Settings2} title="Modelos por tarefa">
        {!canManage ? <PermissionNotice /> : null}
        <div className="space-y-4">
          {TASKS.map((task) => {
            const profile = profileDrafts.find((item) => item.taskKind === task.id) ?? emptyProfile(task.id);
            const selectedConnection = connections.find((connection) => connection.id === profile.connectionId) ?? null;
            const selectedConnectionSupported = selectedConnection
              ? connectionSupportsTask(selectedConnection, task.id)
              : false;
            const availableConnections = connections.filter((connection) => connectionSupportsTask(connection, task.id));
            const catalog = profile.connectionId
              ? modelCatalogs[profile.connectionId]
              : undefined;
            const discoveredModels = profile.connectionId
              ? catalog?.models ?? []
              : [];
            const modelSuggestions = getModelSuggestions(selectedConnection, discoveredModels);
            const usesManualModel = !modelSuggestions.some(
              (suggestion) => suggestion.value === profile.model,
            );
            const modelSelectId = `model-${task.id}`;
            const taskHeadingId = `ai-task-${task.id}`;
            return (
              <fieldset aria-labelledby={taskHeadingId} className="min-w-0 rounded-xl border border-border bg-card p-4 sm:p-5" disabled={!canManage} key={task.id}>
                <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
                  <div className="min-w-0"><h3 className="font-semibold text-foreground" id={taskHeadingId}>{task.label}</h3><p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">{task.description}</p></div>
                  <label className="flex shrink-0 items-center gap-2 text-xs font-medium text-foreground"><Checkbox aria-label={`Ativar ${task.label.toLocaleLowerCase("pt-BR")}`} checked={profile.enabled} onCheckedChange={(checked) => updateProfileDraft(setProfileDrafts, task.id, { enabled: checked === true })} /> Ativa</label>
                </div>
                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <Field label="Conexão">
                    <Select onValueChange={(value) => {
                      const connectionId = value === NO_CONNECTION_VALUE ? null : value;
                      const connection = connections.find((item) => item.id === connectionId) ?? null;
                      updateProfileDraft(setProfileDrafts, task.id, {
                        connectionId,
                        model: connection?.providerId === "codex" ? "default" : "",
                      });
                    }} value={profile.connectionId ?? NO_CONNECTION_VALUE}>
                      <SelectTrigger aria-label={`Conexão para ${task.label.toLocaleLowerCase("pt-BR")}`} className={inputClass}><SelectValue placeholder="Selecione uma conexão" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NO_CONNECTION_VALUE}>Selecione uma conexão</SelectItem>
                        {selectedConnection && !selectedConnectionSupported ? <SelectItem disabled value={selectedConnection.id}>{selectedConnection.label} · indisponível</SelectItem> : null}
                        {availableConnections.map((connection) => <SelectItem key={connection.id} value={connection.id}>{connection.label} · {providerMeta(connection.providerId).label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </Field>
                  <div className="relative min-w-0 max-w-full text-xs font-medium text-foreground">
                    <label className="block min-h-4 pr-36 leading-4" htmlFor={modelSelectId}>Modelo</label>
                    <Button className="absolute -top-1 right-0" disabled={!selectedConnection || catalog?.status === "loading"} onClick={() => selectedConnection && void discoverModels(selectedConnection)} size="sm" type="button" variant="ghost">
                      {catalog?.status === "loading" ? <LoaderCircle className="animate-spin" size={13} /> : <RefreshCw size={13} />} Atualizar modelos
                    </Button>
                    <Select disabled={!selectedConnection} onValueChange={(value) => {
                      updateProfileDraft(setProfileDrafts, task.id, {
                        model: value === MANUAL_MODEL_VALUE ? "" : value,
                      });
                    }} value={usesManualModel ? MANUAL_MODEL_VALUE : profile.model}>
                      <SelectTrigger aria-label={`Modelo para ${task.label.toLocaleLowerCase("pt-BR")}`} className={inputClass} id={modelSelectId}><SelectValue placeholder="Selecione um modelo" /></SelectTrigger>
                      <SelectContent>
                        {modelSuggestions.map((suggestion) => <SelectItem key={suggestion.value} value={suggestion.value}>{suggestion.label ?? suggestion.value}</SelectItem>)}
                        <SelectItem value={MANUAL_MODEL_VALUE}>Informar modelo manualmente…</SelectItem>
                      </SelectContent>
                    </Select>
                    {usesManualModel ? <Input aria-label={`Modelo manual para ${task.label.toLocaleLowerCase("pt-BR")}`} className={inputClass} onChange={(event) => updateProfileDraft(setProfileDrafts, task.id, { model: event.target.value })} placeholder={selectedConnection?.providerId === "codex" ? "Ex.: gpt-5.6-luna" : "Identificador aceito pelo provedor"} required={profile.enabled} value={profile.model} /> : null}
                    <span className={`mt-1.5 flex items-start gap-1.5 text-xs font-normal leading-5 ${catalog?.status === "error" ? "text-destructive" : "text-muted-foreground"}`} role={catalog?.status === "error" ? "alert" : "status"}>
                      {catalog?.status === "loading" ? "Carregando modelos disponíveis…" : catalog?.status === "error" ? `Não foi possível carregar os modelos: ${catalog.message}` : catalog?.status === "success" ? `${catalog.models.length} modelo(s) carregado(s). Você também pode informar um identificador manualmente.` : selectedConnection ? "O catálogo será carregado automaticamente." : "Selecione uma conexão para carregar seus modelos."}
                    </span>
                    {selectedConnection?.providerId === "codex" && profile.model === "default" ? <span className="mt-1 block text-xs font-normal leading-5 text-muted-foreground">Padrão da conta Codex: usa o modelo definido na configuração local.</span> : null}
                  </div>
                </div>
                {task.id === "triage" ? (
                  <div className="mt-4 rounded-xl border border-border bg-muted/30 p-3.5">
                    <div className="grid gap-4 sm:grid-cols-[minmax(0,220px)_minmax(0,1fr)] sm:items-start">
                      <Field
                        hint="Entre 0,5 e 30 minutos. O padrão recomendado é 3 minutos."
                        label="Janela de silêncio"
                      >
                        <InputGroup className="mt-2">
                          <InputGroupInput
                            aria-label="Janela de silêncio em minutos"
                            disabled={!triageSettings}
                            inputMode="decimal"
                            max={30}
                            min={0.5}
                            onChange={(event) => {
                              setSavedNow(false);
                              setSilenceWindowMinutes(event.target.value);
                            }}
                            step={0.5}
                            type="number"
                            value={silenceWindowMinutes}
                          />
                          <InputGroupAddon align="inline-end">
                            <InputGroupText className="text-xs">minutos</InputGroupText>
                          </InputGroupAddon>
                        </InputGroup>
                      </Field>
                      <Card className="gap-0 rounded-lg px-3 py-2.5 text-xs leading-5 text-muted-foreground shadow-none sm:mt-6" size="sm">
                        <strong className="block text-foreground">Como o agrupamento funciona</strong>
                        <span className="mt-1 block">
                          Nova mensagem externa reinicia a contagem. Mensagens da equipe entram apenas como contexto e não adiam a análise.
                        </span>
                      </Card>
                    </div>
                  </div>
                ) : null}
                {selectedConnection && selectedConnectionSupported ? <TaskSecurityNote connection={selectedConnection} taskKind={task.id} /> : null}
                {selectedConnection && !selectedConnectionSupported ? <p className="mt-3 flex items-start gap-2 text-xs leading-5 text-amber-700"><CircleAlert className="mt-0.5 shrink-0" size={14} /> Esta conexão está pausada ou não oferece a capacidade exigida por {task.label.toLocaleLowerCase("pt-BR")}.</p> : null}
                {!selectedConnection && availableConnections.length === 0 ? <p className="mt-3 flex items-start gap-2 text-xs leading-5 text-amber-700"><CircleAlert className="mt-0.5 shrink-0" size={14} /> Nenhuma conexão ativa oferece esta tarefa. Ative uma conexão compatível ou configure um novo provedor.</p> : null}
              </fieldset>
            );
          })}
        </div>
        {canManage ? (
          <Card
            className={actionBarFloating
              ? "fixed inset-x-3 bottom-3 z-[80] gap-0 rounded-xl bg-card/95 p-3 shadow-2xl backdrop-blur sm:left-auto sm:right-4 sm:w-[min(560px,calc(100vw-2rem))] sm:p-4"
              : "mt-5 gap-0 rounded-xl p-3 shadow-sm sm:p-4"}
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
              <div aria-live="polite" className="min-w-0 flex-1" role="status">
                <strong className={`block text-sm ${aiSettingsDirty ? "text-amber-700" : "text-emerald-700"}`}>
                  {aiSettingsDirty ? "Alterações não salvas" : savedNow ? "Salvo agora" : "Perfis salvos"}
                </strong>
                <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                  {aiSettingsDirty
                    ? "Revise os modelos e a janela de silêncio antes de sair desta aba."
                    : "Os fluxos e o agrupamento estão sincronizados com o SQLite local."}
                </span>
                {aiSettingsInvalid ? (
                  <p className="mt-1.5 text-xs leading-5 text-amber-700">
                    Toda tarefa ativa precisa de uma conexão compatível e um modelo; a janela deve ficar entre 0,5 e 30 minutos.
                  </p>
                ) : null}
              </div>
              <Button
                className="w-full shrink-0 sm:w-auto"
                disabled={savingProfiles || aiSettingsInvalid || !aiSettingsDirty}
                onClick={() => void saveProfiles()}
                size="default"
                type="button"
                variant="default"
              >
                {savingProfiles ? <LoaderCircle className="animate-spin" size={16} /> : <Save size={16} />}
                Salvar alterações
              </Button>
            </div>
          </Card>
        ) : null}
      </SectionLayout>
      <AudioTranscriptionSection canManage={canManage} onFeedback={onFeedback} />
    </div>
  );
}

function ConnectionEditor({ draft, busy, onChange, onCancel, onSubmit }: { draft: ConnectionDraft; busy: boolean; onChange(value: ConnectionDraft): void; onCancel(): void; onSubmit(event: FormEvent): void }) {
  const provider = providerMeta(draft.providerId);
  return (
    <form className="mb-6 rounded-xl border border-border bg-muted/30 p-4 sm:p-5" onSubmit={onSubmit}>
      <div className="mb-4 flex items-start justify-between gap-3"><div><h3 className="font-semibold text-foreground">{draft.id ? "Editar conexão" : "Nova conexão"}</h3><p className="mt-1 text-xs text-muted-foreground">{provider.description}</p></div><Button aria-label="Fechar editor" onClick={onCancel} size="icon" type="button" variant="ghost"><X size={16} /></Button></div>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Nome da conexão"><Input className={inputClass} onChange={(event) => onChange({ ...draft, label: event.target.value })} placeholder="Ex.: OpenAI de produção" required value={draft.label} /></Field>
        <Field label="Provedor"><Select disabled={Boolean(draft.id)} onValueChange={(value) => { const providerId = value as AiProviderId; const nextProvider = providerMeta(providerId); onChange({ ...draft, providerId, baseUrl: nextProvider.defaultBaseUrl, apiKey: "" }); }} value={draft.providerId}><SelectTrigger className={inputClass}><SelectValue /></SelectTrigger><SelectContent>{PROVIDERS.filter((item) => draft.id || item.id !== "codex").map((item) => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}</SelectContent></Select></Field>
        {provider.supportsBaseUrl ? <Field label="URL da API" hint={draft.providerId === "ollama" ? "Mantenha local para não expor o serviço na rede." : "Altere apenas ao usar um endpoint compatível."}><Input className={inputClass} onChange={(event) => onChange({ ...draft, baseUrl: event.target.value })} placeholder={provider.defaultBaseUrl} type="url" value={draft.baseUrl} /></Field> : null}
        {provider.requiresSecret ? <Field label={draft.hasSecret ? "Substituir chave de API" : "Chave de API"} hint={draft.hasSecret ? "Deixe em branco para manter a credencial já protegida." : "A chave é criptografada localmente e nunca volta para esta tela."}><Input autoComplete="off" className={inputClass} onChange={(event) => onChange({ ...draft, apiKey: event.target.value })} placeholder={draft.hasSecret ? "Credencial já configurada" : "Cole a chave do provedor"} required={!draft.hasSecret} type="password" value={draft.apiKey} /></Field> : null}
      </div>
      <label className="mt-4 flex items-center gap-3 text-xs font-medium text-foreground"><Checkbox checked={draft.enabled} onCheckedChange={(checked) => onChange({ ...draft, enabled: checked === true })} /> Disponível para os fluxos de IA</label>
      <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><Button className="w-full sm:w-auto" onClick={onCancel} size="default" type="button" variant="outline">Cancelar</Button><Button className="w-full sm:w-auto" disabled={busy || !draft.label.trim() || (provider.requiresSecret && !draft.hasSecret && !draft.apiKey.trim())} size="default" type="submit" variant="default">{busy ? <LoaderCircle className="animate-spin" size={16} /> : <Save size={16} />} Salvar conexão</Button></div>
    </form>
  );
}
