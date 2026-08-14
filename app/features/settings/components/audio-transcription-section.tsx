"use client";

import {
  AudioLines,
  CheckCircle2,
  CircleAlert,
  Download,
  HardDrive,
  History,
  LoaderCircle,
  MemoryStick,
  Save,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card";
import { Progress } from "@/app/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/app/components/ui/select";
import { Switch } from "@/app/components/ui/switch";
import {
  getAudioTranscriptionSettings,
  installAudioTranscriptionModel,
  queueHistoricalAudioTranscription,
  removeAudioTranscriptionModel,
  updateAudioTranscriptionSettings,
  type AudioTranscriptionSettingsDto,
} from "@/app/lib/settings";
import { SectionLayout } from "./settings-support";

export function AudioTranscriptionSection({
  canManage,
  onFeedback,
}: {
  canManage: boolean;
  onFeedback(tone: "success" | "error", message: string): void;
}) {
  const [settings, setSettings] = useState<AudioTranscriptionSettingsDto | null>(null);
  const [draft, setDraft] = useState<{
    enabled: boolean;
    modelId: string;
    autoTranscribeNew: boolean;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const next = await getAudioTranscriptionSettings();
      setSettings(next);
      setDraft((current) =>
        current ?? {
          enabled: next.enabled,
          modelId: next.modelId,
          autoTranscribeNew: next.autoTranscribeNew,
        },
      );
    } catch (error) {
      onFeedback("error", messageFor(error));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [onFeedback]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const shouldPoll = Boolean(
    settings?.models.some((model) => model.state === "downloading") ||
      settings?.runtime.state === "loading" ||
      settings?.runtime.state === "processing" ||
      settings?.queue.processing,
  );
  useEffect(() => {
    if (!shouldPoll) return;
    const interval = window.setInterval(() => void load(true), 1_000);
    return () => window.clearInterval(interval);
  }, [load, shouldPoll]);

  const dirty = Boolean(
    settings &&
      draft &&
      (settings.enabled !== draft.enabled ||
        settings.modelId !== draft.modelId ||
        settings.autoTranscribeNew !== draft.autoTranscribeNew),
  );
  const selectedModel = useMemo(
    () => settings?.models.find((model) => model.id === draft?.modelId) ?? null,
    [draft?.modelId, settings?.models],
  );
  const downloadingModel = settings?.models.find((model) => model.state === "downloading") ?? null;

  async function save(): Promise<void> {
    if (!draft) return;
    setBusy("save");
    try {
      const next = await updateAudioTranscriptionSettings({
        ...draft,
        language: "pt",
      });
      setSettings(next);
      setDraft({
        enabled: next.enabled,
        modelId: next.modelId,
        autoTranscribeNew: next.autoTranscribeNew,
      });
      onFeedback("success", "A transcrição local de áudios foi atualizada.");
    } catch (error) {
      onFeedback("error", messageFor(error));
    } finally {
      setBusy(null);
    }
  }

  async function activate(): Promise<void> {
    if (!draft || selectedModel?.state !== "installed") return;
    setBusy("activate");
    try {
      const next = await updateAudioTranscriptionSettings({
        ...draft,
        enabled: true,
        autoTranscribeNew: true,
        language: "pt",
      });
      setSettings(next);
      setDraft({
        enabled: next.enabled,
        modelId: next.modelId,
        autoTranscribeNew: next.autoTranscribeNew,
      });
      onFeedback("success", "Transcrição ativada para os próximos áudios.");
    } catch (error) {
      onFeedback("error", messageFor(error));
    } finally {
      setBusy(null);
    }
  }

  async function install(modelId: string): Promise<void> {
    setBusy(`install:${modelId}`);
    try {
      await installAudioTranscriptionModel(modelId);
      await load(true);
      onFeedback("success", "Download iniciado. Você pode continuar usando o Threadmark.");
    } catch (error) {
      onFeedback("error", messageFor(error));
    } finally {
      setBusy(null);
    }
  }

  async function remove(modelId: string): Promise<void> {
    if (!window.confirm("Remover este modelo local e liberar o espaço em disco?")) return;
    setBusy(`remove:${modelId}`);
    try {
      await removeAudioTranscriptionModel(modelId);
      await load(true);
      onFeedback("success", "Modelo removido do armazenamento local.");
    } catch (error) {
      onFeedback("error", messageFor(error));
    } finally {
      setBusy(null);
    }
  }

  async function queueHistory(): Promise<void> {
    if (!window.confirm("Colocar até 100 áudios antigos na fila? Eles serão transcritos localmente e não abrirão tickets automaticamente.")) return;
    setBusy("history");
    try {
      const queued = await queueHistoricalAudioTranscription(100);
      await load(true);
      onFeedback(
        "success",
        queued
          ? `${queued} áudio(s) antigo(s) adicionado(s) à fila.`
          : "Nenhum áudio antigo novo foi encontrado.",
      );
    } catch (error) {
      onFeedback("error", messageFor(error));
    } finally {
      setBusy(null);
    }
  }

  return (
    <SectionLayout
      description="Converta áudios recebidos em texto no próprio computador, sem enviar o arquivo a um provedor externo."
      icon={AudioLines}
      title="Transcrição local de áudios"
    >
      {loading || !settings || !draft ? (
        <div className="flex min-h-36 items-center justify-center text-sm text-muted-foreground" role="status">
          <LoaderCircle className="mr-2 animate-spin" size={18} /> Carregando transcrição local…
        </div>
      ) : (
        <div className="space-y-5">
          <div className="grid gap-4 rounded-xl border border-border bg-muted/30 p-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
            <div className="min-w-0">
              <strong className="text-sm text-foreground">Processamento privado e sob demanda</strong>
              <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
                O modelo é baixado uma única vez, carregado somente durante o trabalho e liberado da memória após {Math.round(settings.runtime.unloadAfterSeconds / 60)} minutos sem uso. O áudio original permanece preservado.
              </p>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Badge className="gap-1.5 border-emerald-200 bg-emerald-50 text-emerald-700" variant="outline">
                <CheckCircle2 size={13} /> Somente local
              </Badge>
              <Badge
                className={settings.enabled ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"}
                variant="outline"
              >
                {settings.enabled ? "Transcrição ativa" : "Transcrição desativada"}
              </Badge>
            </div>
          </div>

          {selectedModel?.state === "installed" && !settings.enabled ? (
            <Card className="gap-0 border-amber-200 bg-amber-50/70" role="status" size="sm">
              <CardContent className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-start gap-2.5">
                  <CircleAlert className="mt-0.5 shrink-0 text-amber-700" size={16} />
                  <div className="min-w-0">
                    <strong className="text-sm text-amber-950">Modelo instalado, transcrição desativada</strong>
                    <p className="mt-1 text-xs leading-5 text-amber-800">
                      O Whisper está pronto, mas novos áudios não entram na fila até a transcrição ser ativada.
                    </p>
                  </div>
                </div>
                <Button
                  className="shrink-0"
                  disabled={!canManage || busy === "activate"}
                  onClick={() => void activate()}
                  size="sm"
                  type="button"
                >
                  {busy === "activate" ? <LoaderCircle className="animate-spin" size={14} /> : <CheckCircle2 size={14} />}
                  Ativar agora
                </Button>
              </CardContent>
            </Card>
          ) : null}

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
            <div className="space-y-4 rounded-xl border border-border p-4">
              <label className="block text-xs font-medium text-foreground">
                Modelo de transcrição
                <Select disabled={!canManage} onValueChange={(modelId) => setDraft({ ...draft, modelId, enabled: modelId === draft.modelId ? draft.enabled : false })} value={draft.modelId}>
                  <SelectTrigger className="mt-2 w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {settings.models.map((model) => (
                      <SelectItem key={model.id} value={model.id}>
                        {model.label}{model.recommended ? " · recomendado" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <SettingSwitch
                checked={draft.autoTranscribeNew}
                description="Áudios antigos só entram quando você usar a ação manual abaixo."
                disabled={!canManage}
                label="Transcrever novos áudios automaticamente"
                onCheckedChange={(checked) => setDraft({ ...draft, autoTranscribeNew: checked })}
              />
              <SettingSwitch
                checked={draft.enabled}
                description={selectedModel?.state === "installed" ? "O worker acompanha a fila enquanto o Threadmark estiver ligado." : "Baixe o modelo selecionado antes de ativar."}
                disabled={!canManage || selectedModel?.state !== "installed"}
                label="Ativar transcrição"
                onCheckedChange={(checked) => setDraft({ ...draft, enabled: checked })}
              />
              <div className="flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
                <Button disabled={!canManage || busy === "history" || !settings.enabled || !draft.enabled} onClick={() => void queueHistory()} size="sm" type="button" variant="outline">
                  {busy === "history" ? <LoaderCircle className="animate-spin" size={14} /> : <History size={14} />} Transcrever áudios antigos
                </Button>
                <Button disabled={!canManage || !dirty || busy === "save"} onClick={() => void save()} size="sm" type="button">
                  {busy === "save" ? <LoaderCircle className="animate-spin" size={14} /> : <Save size={14} />} Salvar transcrição
                </Button>
              </div>
            </div>

            <Card className="gap-0" size="sm">
              <CardHeader className="border-b">
                <CardTitle>Recursos locais</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4 pt-3">
                <ResourceMeter icon={MemoryStick} label="RAM estimada" total={settings.runtime.totalMemoryBytes} totalLabel="da memória total" value={selectedModel?.estimatedRamBytes ?? 0} />
                <ResourceMeter icon={HardDrive} label="Disco do modelo" total={settings.runtime.availableDiskBytes} totalLabel="do espaço disponível" value={selectedModel?.cacheBytes || selectedModel?.estimatedDiskBytes || 0} />
                <div className="grid grid-cols-2 gap-2 text-center">
                  <QueueStat label="Na fila" value={settings.queue.queued} />
                  <QueueStat label="Em revisão" value={settings.queue.review} />
                </div>
                <p className="break-words text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">
                  Estado: {runtimeLabel(settings.runtime.state)}{settings.runtime.error ? ` · ${settings.runtime.error}` : ""}
                </p>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-3 xl:grid-cols-3">
            {settings.models.map((model) => (
              <Card className={model.id === draft.modelId ? "gap-0 ring-2 ring-primary/30" : "gap-0"} key={model.id} size="sm">
                <CardHeader className="border-b">
                  <div className="flex min-w-0 items-start justify-between gap-2">
                    <div className="min-w-0">
                      <CardTitle className="flex flex-wrap items-center gap-1.5">
                        {model.label}
                        {model.recommended ? <Badge variant="secondary">Recomendado</Badge> : null}
                      </CardTitle>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">{model.description}</p>
                    </div>
                    <ModelStateBadge state={model.state} />
                  </div>
                </CardHeader>
                <CardContent className="space-y-3 pt-3">
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>{formatBytes(model.estimatedDiskBytes)} no disco</span>
                    <span>{formatBytes(model.estimatedRamBytes)} de RAM</span>
                  </div>
                  {model.state === "downloading" ? (
                    <div>
                      <div className="mb-1 flex justify-between text-xs text-muted-foreground"><span>Baixando</span><span>{Math.round(model.progress * 100)}%</span></div>
                      <Progress value={model.progress * 100} />
                    </div>
                  ) : null}
                  {model.error ? <p className="flex items-start gap-1.5 break-words text-xs leading-5 text-destructive [overflow-wrap:anywhere]"><CircleAlert className="mt-0.5 shrink-0" size={13} />{model.error}</p> : null}
                  {canManage ? (
                    model.state === "installed" ? (
                      <Button className="w-full" disabled={Boolean(downloadingModel) || busy === `remove:${model.id}` || (settings.enabled && settings.modelId === model.id)} onClick={() => void remove(model.id)} size="sm" type="button" variant="outline">
                        {busy === `remove:${model.id}` ? <LoaderCircle className="animate-spin" size={14} /> : <Trash2 size={14} />} Remover modelo
                      </Button>
                    ) : (
                      <Button className="w-full" disabled={Boolean(downloadingModel) || settings.runtime.state === "loading" || settings.runtime.state === "processing" || busy === `install:${model.id}`} onClick={() => void install(model.id)} size="sm" type="button" variant="outline">
                        {model.state === "downloading" || busy === `install:${model.id}` ? <LoaderCircle className="animate-spin" size={14} /> : <Download size={14} />} {model.state === "error" ? "Tentar novamente" : "Baixar modelo"}
                      </Button>
                    )
                  ) : null}
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}
    </SectionLayout>
  );
}

function SettingSwitch({ label, description, checked, disabled, onCheckedChange }: { label: string; description: string; checked: boolean; disabled: boolean; onCheckedChange(value: boolean): void }) {
  return <label className="flex items-start justify-between gap-4 rounded-lg border border-border p-3"><span className="min-w-0"><strong className="block text-xs font-medium text-foreground">{label}</strong><span className="mt-1 block text-xs leading-5 text-muted-foreground">{description}</span></span><Switch checked={checked} className="mt-0.5" disabled={disabled} onCheckedChange={onCheckedChange} /></label>;
}

function ResourceMeter({ icon: Icon, label, value, total, totalLabel }: { icon: typeof MemoryStick; label: string; value: number; total: number | null; totalLabel: string }) {
  const percentage = total && total > 0 ? Math.min(100, (value / total) * 100) : 0;
  return <div><div className="mb-1.5 flex items-center justify-between gap-2 text-xs"><span className="flex items-center gap-1.5 font-medium text-foreground"><Icon size={13} />{label}</span><span className="text-muted-foreground">{formatBytes(value)}</span></div><Progress value={percentage} /><p className="mt-1 text-xs text-muted-foreground">{total ? `${percentage.toFixed(1)}% de ${formatBytes(total)} ${totalLabel}` : "Capacidade local não identificada"}</p></div>;
}

function QueueStat({ label, value }: { label: string; value: number }) {
  return <div className="rounded-lg bg-muted p-2"><strong className="block text-sm text-foreground">{value}</strong><span className="text-xs text-muted-foreground">{label}</span></div>;
}

function ModelStateBadge({ state }: { state: AudioTranscriptionSettingsDto["models"][number]["state"] }) {
  if (state === "installed") return <Badge className="border-emerald-200 bg-emerald-50 text-emerald-700" variant="outline">Instalado</Badge>;
  if (state === "downloading") return <Badge variant="secondary">Baixando</Badge>;
  if (state === "error") return <Badge variant="destructive">Erro</Badge>;
  return <Badge variant="outline">Não instalado</Badge>;
}

function runtimeLabel(state: AudioTranscriptionSettingsDto["runtime"]["state"]): string {
  return { idle: "ocioso", loading: "carregando modelo", ready: "pronto", processing: "transcrevendo", error: "com erro" }[state];
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : "Não foi possível concluir a ação.";
}
