"use client";

import {
  AlertCircle,
  CheckCircle2,
  LoaderCircle,
  MessageSquareShare,
  Pencil,
  Plus,
  Power,
  TestTube2,
  Trash2,
  Webhook,
} from "lucide-react";
import { useState } from "react";

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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/components/ui/card";
import { Input } from "@/app/components/ui/input";
import { NativeSelect } from "@/app/components/ui/native-select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/app/components/ui/sheet";
import { Switch } from "@/app/components/ui/switch";
import { Textarea } from "@/app/components/ui/textarea";
import type {
  ConnectedAppSummary,
  ConnectedAppType,
  UpsertConnectedAppInput,
} from "../domain";

type ConnectedAppsPanelProps = {
  apps: ConnectedAppSummary[];
  busyId: string | null;
  error: string | null;
  loading: boolean;
  onDelete: (app: ConnectedAppSummary) => Promise<void>;
  onSave: (input: UpsertConnectedAppInput, id?: string) => Promise<void>;
  onTest: (app: ConnectedAppSummary) => Promise<void>;
  onRetry: () => void;
};

type AppDraft = UpsertConnectedAppInput & { id?: string };

function emptyDraft(type: ConnectedAppType = "slack_webhook"): AppDraft {
  return {
    type,
    name: type === "slack_webhook" ? "Slack do suporte" : "Minha API",
    description: "",
    enabled: true,
    endpoint: "",
    secret: "",
  };
}

function draftFrom(app: ConnectedAppSummary): AppDraft {
  return {
    id: app.id,
    type: app.type,
    name: app.name,
    description: app.description,
    enabled: app.status !== "disabled",
    endpoint: "",
    secret: "",
  };
}

export function ConnectedAppsPanel({
  apps,
  busyId,
  error,
  loading,
  onDelete,
  onSave,
  onTest,
  onRetry,
}: ConnectedAppsPanelProps) {
  const [draft, setDraft] = useState<AppDraft | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ConnectedAppSummary | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!draft || !draft.name.trim()) return;
    if (!draft.id && !draft.endpoint.trim()) return;
    setSaving(true);
    try {
      await onSave(
        {
          type: draft.type,
          name: draft.name.trim(),
          description: draft.description?.trim() || null,
          enabled: draft.enabled,
          endpoint: draft.endpoint.trim(),
          ...(draft.secret?.trim() ? { secret: draft.secret.trim() } : {}),
        },
        draft.id,
      );
      setDraft(null);
    } catch {
      // A tela principal exibe a mensagem e mantém o formulário aberto para correção.
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Apps conectados</h2>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
            As conexões ativas liberam ações no editor. Credenciais são armazenadas localmente e nunca voltam para esta tela.
          </p>
        </div>
        <Button onClick={() => setDraft(emptyDraft())} size="sm" type="button">
          <Plus size={14} /> Conectar app
        </Button>
      </div>

      {error ? (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-xs text-destructive" role="alert">
          <AlertCircle size={15} /> <span className="min-w-0 flex-1 break-words">{error}</span>
          <Button onClick={onRetry} size="sm" type="button" variant="outline">Tentar novamente</Button>
        </div>
      ) : null}

      {loading ? (
        <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="animate-spin" size={17} /> Carregando conexões…
        </div>
      ) : null}

      {!loading && !apps.length ? (
        <Card className="border-dashed py-10 text-center">
          <CardContent>
            <span className="mx-auto grid size-11 place-items-center rounded-xl bg-primary/10 text-primary"><Webhook size={22} /></span>
            <h3 className="mt-3 text-sm font-semibold">Nenhum app conectado</h3>
            <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">
              Comece com um Slack via webhook ou uma API personalizada. O WhatsApp permanece somente leitura.
            </p>
            <Button className="mt-4" onClick={() => setDraft(emptyDraft())} size="sm" type="button">
              <Plus size={14} /> Criar primeira conexão
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid grid-cols-2 gap-3 max-[820px]:grid-cols-1">
        {apps.map((app) => {
          const Icon = app.type === "slack_webhook" ? MessageSquareShare : Webhook;
          const busy = busyId === app.id;
          return (
            <Card key={app.id}>
              <CardHeader className="grid-cols-[auto_1fr_auto] items-start gap-x-3">
                <span className="row-span-2 grid size-9 place-items-center rounded-xl bg-primary/10 text-primary"><Icon size={18} /></span>
                <CardTitle className="min-w-0 truncate text-sm">{app.name}</CardTitle>
                <Badge
                  className="row-span-2"
                  variant={app.status === "active" ? "secondary" : app.status === "error" ? "destructive" : "outline"}
                >
                  {app.status === "active" ? "Ativo" : app.status === "error" ? "Com erro" : "Pausado"}
                </Badge>
                <CardDescription className="col-start-2 text-xs">
                  {app.type === "slack_webhook" ? "Slack webhook" : "API personalizada"}
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3">
                <p className="min-h-10 break-words text-xs leading-relaxed text-muted-foreground">
                  {app.description || "Sem descrição."}
                </p>
                <div className="rounded-lg bg-muted/60 p-2.5 text-xs">
                  <span className="block font-medium">Destino</span>
                  <code className="mt-1 block truncate text-muted-foreground">
                    {app.endpointPreview || "Segredo configurado e protegido"}
                  </code>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button disabled={busy} onClick={() => void onTest(app)} size="sm" type="button" variant="outline">
                    {busy ? <LoaderCircle className="animate-spin" size={14} /> : <TestTube2 size={14} />} Testar
                  </Button>
                  <Button onClick={() => setDraft(draftFrom(app))} size="sm" type="button" variant="outline"><Pencil size={14} /> Editar</Button>
                  <Button className="ml-auto" onClick={() => setDeleteTarget(app)} size="icon-sm" type="button" variant="destructive" aria-label={`Excluir ${app.name}`}><Trash2 size={14} /></Button>
                </div>
                {app.lastTestAt ? (
                  <p className="flex items-center gap-1.5 text-2xs text-muted-foreground">
                    {app.lastTestSucceeded ? <CheckCircle2 className="text-emerald-600" size={12} /> : <AlertCircle className="text-destructive" size={12} />}
                    Último teste {app.lastTestSucceeded ? "concluído" : "falhou"}.
                  </p>
                ) : null}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Sheet onOpenChange={(open) => { if (!open) setDraft(null); }} open={Boolean(draft)}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>{draft?.id ? "Editar app conectado" : "Conectar app"}</SheetTitle>
            <SheetDescription>
              O segredo é aceito apenas ao salvar. Depois ele será exibido somente como configurado.
            </SheetDescription>
          </SheetHeader>
          {draft ? (
            <div className="grid min-h-0 flex-1 content-start gap-4 overflow-y-auto p-4">
              <label className="grid gap-1.5 text-xs font-medium">
                Tipo
                <NativeSelect
                  disabled={Boolean(draft.id)}
                  onChange={(event) => setDraft(emptyDraft(event.target.value as ConnectedAppType))}
                  value={draft.type}
                  wrapperClassName="w-full"
                >
                  <option value="slack_webhook">Slack via webhook</option>
                  <option value="custom_http">API personalizada</option>
                </NativeSelect>
              </label>
              <label className="grid gap-1.5 text-xs font-medium">Nome<Input maxLength={100} onChange={(event) => setDraft({ ...draft, name: event.target.value })} value={draft.name} /></label>
              <label className="grid gap-1.5 text-xs font-medium">Descrição<Textarea className="min-h-20" maxLength={300} onChange={(event) => setDraft({ ...draft, description: event.target.value })} value={draft.description ?? ""} /></label>
              <label className="grid gap-1.5 text-xs font-medium">
                {draft.type === "slack_webhook" ? "URL secreta do webhook" : "URL do endpoint"}
                <Input
                  autoComplete="off"
                  onChange={(event) => setDraft({ ...draft, endpoint: event.target.value })}
                  placeholder={draft.id ? "Deixe vazio para manter o valor protegido" : "https://…"}
                  type="password"
                  value={draft.endpoint}
                />
                <span className="font-normal leading-relaxed text-muted-foreground">O valor completo não será reexibido depois de salvo.</span>
              </label>
              {draft.type === "custom_http" ? (
                <label className="grid gap-1.5 text-xs font-medium">
                  Token ou segredo opcional
                  <Input autoComplete="new-password" onChange={(event) => setDraft({ ...draft, secret: event.target.value })} placeholder={draft.id ? "Deixe vazio para manter o atual" : "Bearer…"} type="password" value={draft.secret ?? ""} />
                </label>
              ) : null}
              <label className="flex items-center justify-between gap-3 rounded-xl border p-3 text-xs font-medium">
                <span><span className="flex items-center gap-2"><Power size={14} /> Conexão ativa</span><span className="mt-1 block font-normal text-muted-foreground">Disponibiliza ações no editor de fluxos.</span></span>
                <Switch checked={draft.enabled} onCheckedChange={(enabled) => setDraft({ ...draft, enabled })} />
              </label>
            </div>
          ) : null}
          <div className="flex shrink-0 justify-end gap-2 border-t p-4">
            <Button disabled={saving} onClick={() => setDraft(null)} type="button" variant="outline">Cancelar</Button>
            <Button disabled={saving || !draft?.name.trim() || (!draft.id && !draft.endpoint.trim())} onClick={() => void save()} type="button">
              {saving ? <LoaderCircle className="animate-spin" size={14} /> : null} Salvar conexão
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      <AlertDialog onOpenChange={(open) => { if (!open) setDeleteTarget(null); }} open={Boolean(deleteTarget)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir conexão definitivamente?</AlertDialogTitle>
            <AlertDialogDescription>
              Fluxos que usam {deleteTarget?.name} precisarão ser ajustados antes de uma nova ativação.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => { if (deleteTarget) void onDelete(deleteTarget); }} variant="destructive">Excluir conexão</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
