"use client";

import {
  AlertCircle,
  BookOpenText,
  Bot,
  CheckCircle2,
  LoaderCircle,
  MessageSquareShare,
  Network,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
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

const INTERCOM_REGIONS = [
  { label: "Estados Unidos / Global", value: "https://api.intercom.io/" },
  { label: "Europa", value: "https://api.eu.intercom.io/" },
  { label: "Austrália", value: "https://api.au.intercom.io/" },
] as const;

type AppDraft = Omit<UpsertConnectedAppInput, "type"> & {
  id?: string;
  type: ConnectedAppType | "";
  secretConfigured: boolean;
};

function emptyDraft(type: ConnectedAppType | "" = ""): AppDraft {
  return {
    type,
    name: "",
    description: "",
    enabled: true,
    aiEnabled: type === "intercom" || type === "mcp_remote",
    endpoint: type === "intercom" ? INTERCOM_REGIONS[0].value : "",
    secret: "",
    secretConfigured: false,
    allowPrivateNetwork: false,
    mcpTools: [],
  };
}

function draftFrom(app: ConnectedAppSummary): AppDraft {
  return {
    id: app.id,
    type: app.type,
    name: app.name,
    description: app.description,
    enabled: app.status !== "disabled",
    aiEnabled: app.aiEnabled,
    endpoint: app.type === "intercom"
      ? app.endpointPreview || INTERCOM_REGIONS[0].value
      : "",
    secret: "",
    secretConfigured: app.secretConfigured,
    allowPrivateNetwork: app.allowPrivateNetwork ?? false,
    mcpTools: app.actions?.map((action) => ({
      name: action.id,
      aiEnabled: action.aiEnabled === true,
      automationEnabled: action.automationEnabled === true,
      confirmationRequired: action.confirmationRequired !== false,
    })) ?? [],
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
    if (!draft || !draft.type || !draft.name.trim()) return;
    if (!draft.id && !draft.endpoint.trim()) return;
    if (draft.type === "intercom" && !draft.secretConfigured && !draft.secret?.trim()) return;
    setSaving(true);
    try {
      await onSave(
        {
          type: draft.type,
          name: draft.name.trim(),
          description: draft.description?.trim() || null,
          enabled: draft.enabled,
          aiEnabled: draft.aiEnabled,
          endpoint: draft.endpoint.trim(),
          ...(draft.secret?.trim() ? { secret: draft.secret.trim() } : {}),
          allowPrivateNetwork: draft.allowPrivateNetwork,
          mcpTools: draft.mcpTools,
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
              Escolha o app que deseja conectar. O Threadmark explica exatamente qual credencial é necessária e nunca a reexibe.
            </p>
            <Button className="mt-4" onClick={() => setDraft(emptyDraft())} size="sm" type="button">
              <Plus size={14} /> Criar primeira conexão
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid grid-cols-2 gap-3 max-[820px]:grid-cols-1">
        {apps.map((app) => {
          const Icon = app.type === "slack_webhook"
            ? MessageSquareShare
            : app.type === "intercom"
              ? BookOpenText
              : app.type === "mcp_remote"
                ? Network
                : Webhook;
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
                  {app.type === "slack_webhook"
                    ? "Slack webhook"
                    : app.type === "intercom"
                      ? "Intercom nativo"
                      : app.type === "mcp_remote"
                        ? "Servidor MCP remoto"
                        : "API personalizada"}
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3">
                <p className="min-h-10 break-words text-xs leading-relaxed text-muted-foreground">
                  {app.description || "Sem descrição."}
                </p>
                <div className="rounded-lg bg-muted/60 p-2.5 text-xs">
                  <span className="block font-medium">Destino</span>
                  <code className="mt-1 block truncate text-muted-foreground">
                    {app.type === "intercom"
                      ? "Conversas, autor, coleções e artigos"
                      : app.type === "mcp_remote"
                        ? `${app.actions?.length ?? 0} ferramenta(s) descoberta(s)`
                      : app.endpointPreview || "Segredo configurado e protegido"}
                  </code>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {app.aiEnabled ? (
                    <Badge className="gap-1" variant="outline">
                      <Bot size={12} /> Threadmark AI
                    </Badge>
                  ) : null}
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
                <Select
                  disabled={Boolean(draft.id)}
                  onValueChange={(value) => setDraft(emptyDraft(value as ConnectedAppType))}
                  value={draft.type}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Selecione o app que deseja conectar" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="slack_webhook">Slack via webhook</SelectItem>
                    <SelectItem value="intercom">Intercom</SelectItem>
                    <SelectItem value="custom_http">API personalizada</SelectItem>
                    <SelectItem value="mcp_remote">Servidor MCP remoto</SelectItem>
                  </SelectContent>
                </Select>
              </label>
              {draft.type ? (
                <>
                  <label className="grid gap-1.5 text-xs font-medium">Nome<Input maxLength={100} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Ex.: Intercom do suporte" value={draft.name} /></label>
                  <label className="grid gap-1.5 text-xs font-medium">Descrição<Textarea className="min-h-20" maxLength={300} onChange={(event) => setDraft({ ...draft, description: event.target.value })} placeholder="Descreva quando esta conexão deve ser usada." value={draft.description ?? ""} /></label>
                </>
              ) : (
                <Card className="border-dashed">
                  <CardContent className="p-4 text-xs leading-relaxed text-muted-foreground">
                    Selecione um app acima para visualizar apenas os campos necessários para a conexão.
                  </CardContent>
                </Card>
              )}
              {draft.type === "intercom" ? (
                <>
                  <div className="rounded-xl border border-primary/20 bg-primary/5 p-3 text-xs leading-relaxed">
                    <span className="font-semibold">O que será autorizado</span>
                    <p className="mt-1 text-muted-foreground">
                      Leitura de conversas, do autor associado ao token e de coleções; criação de artigos somente como rascunho e após confirmação explícita no Threadmark AI.
                    </p>
                  </div>
                  <label className="grid gap-1.5 text-xs font-medium">
                    Região do workspace
                    <Select onValueChange={(endpoint) => setDraft({ ...draft, endpoint })} value={draft.endpoint}>
                      <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {INTERCOM_REGIONS.map((region) => (
                          <SelectItem key={region.value} value={region.value}>{region.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                  <label className="grid gap-1.5 text-xs font-medium">
                    Access token da API do Intercom {draft.id && draft.secretConfigured ? "" : "*"}
                    <Input
                      autoComplete="new-password"
                      onChange={(event) => setDraft({ ...draft, secret: event.target.value })}
                      placeholder={draft.id && draft.secretConfigured ? "Deixe vazio para manter o token atual" : "Cole o access token do Intercom"}
                      type="password"
                      value={draft.secret ?? ""}
                    />
                    <span className="font-normal leading-relaxed text-muted-foreground">
                      {draft.id && draft.secretConfigured
                        ? "Um token já está protegido no cofre local. Preencha somente para substituí-lo."
                        : "Obrigatório. O token fica no cofre local, não no SQLite, e nunca é enviado ao modelo de IA."}
                    </span>
                  </label>
                </>
              ) : null}
              {draft.type === "slack_webhook" || draft.type === "custom_http" ? (
                <label className="grid gap-1.5 text-xs font-medium">
                  {draft.type === "slack_webhook" ? "URL secreta do webhook" : "URL do endpoint"}
                  <Input
                    autoComplete="off"
                    onChange={(event) => setDraft({ ...draft, endpoint: event.target.value })}
                    placeholder={draft.id ? "Deixe vazio para manter o valor protegido" : "https://…"}
                    type={draft.type === "slack_webhook" ? "password" : "url"}
                    value={draft.endpoint}
                  />
                  <span className="font-normal leading-relaxed text-muted-foreground">O valor completo não será reexibido depois de salvo.</span>
                </label>
              ) : null}
              {draft.type === "custom_http" ? (
                <label className="grid gap-1.5 text-xs font-medium">
                  Token ou segredo opcional
                  <Input autoComplete="new-password" onChange={(event) => setDraft({ ...draft, secret: event.target.value })} placeholder={draft.id ? "Deixe vazio para manter o atual" : "Bearer…"} type="password" value={draft.secret ?? ""} />
                </label>
              ) : null}
              {draft.type === "mcp_remote" ? (
                <>
                  <div className="rounded-xl border border-primary/20 bg-primary/5 p-3 text-xs leading-relaxed">
                    <span className="font-semibold">Descoberta automática de ferramentas</span>
                    <p className="mt-1 text-muted-foreground">
                      O Threadmark consulta <code>tools/list</code> ao salvar. Cada ferramenta permanece bloqueada até você autorizá-la.
                    </p>
                  </div>
                  <label className="grid gap-1.5 text-xs font-medium">
                    URL do servidor MCP
                    <Input
                      autoComplete="off"
                      onChange={(event) => setDraft({ ...draft, endpoint: event.target.value })}
                      placeholder="https://app.exemplo.com/mcp"
                      type="url"
                      value={draft.endpoint}
                    />
                  </label>
                  <label className="grid gap-1.5 text-xs font-medium">
                    Bearer token opcional
                    <Input
                      autoComplete="new-password"
                      onChange={(event) => setDraft({ ...draft, secret: event.target.value })}
                      placeholder={draft.id && draft.secretConfigured ? "Deixe vazio para manter o token" : "Cole somente se o servidor exigir"}
                      type="password"
                      value={draft.secret ?? ""}
                    />
                    <span className="font-normal leading-relaxed text-muted-foreground">
                      O token fica apenas no cofre local e nunca é devolvido à interface ou enviado ao modelo.
                    </span>
                  </label>
                  <label className="flex items-center justify-between gap-3 rounded-xl border p-3 text-xs font-medium">
                    <span>
                      <span>Permitir servidor na rede local</span>
                      <span className="mt-1 block font-normal leading-relaxed text-muted-foreground">
                        Ative somente para um servidor MCP controlado por você nesta máquina ou rede.
                      </span>
                    </span>
                    <Switch
                      checked={draft.allowPrivateNetwork === true}
                      onCheckedChange={(allowPrivateNetwork) => setDraft({ ...draft, allowPrivateNetwork })}
                    />
                  </label>
                  {draft.id && draft.mcpTools?.length ? (
                    <section className="grid gap-2 rounded-xl border p-3">
                      <div>
                        <h3 className="text-xs font-semibold">Ferramentas descobertas</h3>
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                          Autorize separadamente o uso no chat e em fluxos automáticos.
                        </p>
                      </div>
                      {appActionsForDraft(apps, draft.id).map((action) => {
                        const permission = draft.mcpTools?.find((tool) => tool.name === action.id);
                        if (!permission) return null;
                        return (
                          <div className="grid gap-3 rounded-lg border bg-muted/30 p-3" key={action.id}>
                            <div className="min-w-0">
                              <p className="break-words text-xs font-semibold">{action.name}</p>
                              <p className="mt-1 break-words text-xs leading-relaxed text-muted-foreground">{action.description}</p>
                            </div>
                            <div className="grid gap-2 sm:grid-cols-3">
                              <ToolPermissionToggle
                                checked={permission.aiEnabled}
                                label="Threadmark AI"
                                onCheckedChange={(aiEnabled) => setDraft(updateMcpPermission(draft, action.id, { aiEnabled }))}
                              />
                              <ToolPermissionToggle
                                checked={permission.automationEnabled}
                                label="Automações"
                                onCheckedChange={(automationEnabled) => setDraft(updateMcpPermission(draft, action.id, { automationEnabled }))}
                              />
                              <ToolPermissionToggle
                                checked={permission.confirmationRequired}
                                label="Confirmar ação"
                                onCheckedChange={(confirmationRequired) => setDraft(updateMcpPermission(draft, action.id, { confirmationRequired }))}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </section>
                  ) : null}
                </>
              ) : null}
              {draft.type ? <label className="flex items-center justify-between gap-3 rounded-xl border p-3 text-xs font-medium">
                <span><span className="flex items-center gap-2"><Power size={14} /> Conexão ativa</span><span className="mt-1 block font-normal text-muted-foreground">{draft.type === "intercom" ? "Disponibiliza consultas e ações autorizadas para o Threadmark AI." : "Disponibiliza ações no editor de fluxos."}</span></span>
                <Switch checked={draft.enabled} onCheckedChange={(enabled) => setDraft({ ...draft, enabled })} />
              </label> : null}
              {draft.type ? <label className="flex items-center justify-between gap-3 rounded-xl border border-primary/20 bg-primary/5 p-3 text-xs font-medium">
                <span>
                  <span className="flex items-center gap-2"><Bot size={14} /> Disponível para o Threadmark AI</span>
                  <span className="mt-1 block font-normal leading-relaxed text-muted-foreground">
                    Autoriza o agente a executar ações externas deste app somente quando você pedir explicitamente no chat. Cada execução fica auditada.
                  </span>
                </span>
                <Switch
                  checked={draft.aiEnabled}
                  disabled={!draft.enabled}
                  onCheckedChange={(aiEnabled) => setDraft({ ...draft, aiEnabled })}
                />
              </label> : null}
            </div>
          ) : null}
          <div className="flex shrink-0 justify-end gap-2 border-t p-4">
            <Button disabled={saving} onClick={() => setDraft(null)} type="button" variant="outline">Cancelar</Button>
            <Button
              disabled={
                saving ||
                !draft?.type ||
                !draft.name.trim() ||
                (!draft.id && !draft.endpoint.trim()) ||
                (draft.type === "intercom" && !draft.secretConfigured && !draft.secret?.trim())
              }
              onClick={() => void save()}
              type="button"
            >
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

function appActionsForDraft(apps: ConnectedAppSummary[], appId: string) {
  return apps.find((app) => app.id === appId)?.actions ?? [];
}

function updateMcpPermission(
  draft: AppDraft,
  toolName: string,
  change: Partial<NonNullable<AppDraft["mcpTools"]>[number]>,
): AppDraft {
  return {
    ...draft,
    mcpTools: draft.mcpTools?.map((tool) =>
      tool.name === toolName ? { ...tool, ...change } : tool,
    ) ?? [],
  };
}

function ToolPermissionToggle({
  checked,
  label,
  onCheckedChange,
}: {
  checked: boolean;
  label: string;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-2 rounded-lg border bg-background px-2.5 py-2 text-xs font-medium">
      <span>{label}</span>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </label>
  );
}
