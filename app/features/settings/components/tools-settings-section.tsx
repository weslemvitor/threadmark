"use client";

import { Button } from "@/app/components/ui/button";
import { Checkbox } from "@/app/components/ui/checkbox";
import { Input } from "@/app/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/app/components/ui/select";
import { Textarea } from "@/app/components/ui/textarea";

import {
  BookOpen,
  Bug,
  Check,
  CheckCircle2,
  CircleAlert,
  Cloud,
  Database,
  Folder,
  LoaderCircle,
  Plus,
  Power,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";

import {
  createLocalTool,
  deleteLocalTool,
  getLocalTools,
  testLocalTool,
  updateLocalTool,
  type LocalToolDto,
  type LocalToolOperation,
  type LocalToolType,
  type LocalToolWriteInput,
} from "@/app/lib/settings";

const inputClass =
  "mt-2 w-full min-w-0 max-w-full";
type ToolMeta = {
  label: string;
  description: string;
  icon: LucideIcon;
  operations: Array<{ id: LocalToolOperation; label: string }>;
};

const TOOL_META: Record<LocalToolType, ToolMeta> = {
  codebase: {
    label: "Codebase",
    description: "Autoriza leitura e busca em uma pasta de código.",
    icon: Folder,
    operations: [
      { id: "list_files", label: "Listar arquivos" },
      { id: "search_files", label: "Buscar no código" },
      { id: "read_files", label: "Ler arquivos" },
    ],
  },
  knowledge: {
    label: "Base local",
    description: "Autoriza leitura de documentos, notas ou um vault local.",
    icon: BookOpen,
    operations: [
      { id: "list_files", label: "Listar arquivos" },
      { id: "search_files", label: "Buscar conteúdo" },
      { id: "read_files", label: "Ler arquivos" },
    ],
  },
  debugger_skill: {
    label: "Skill de investigação",
    description: "Disponibiliza uma skill local com regras próprias de diagnóstico.",
    icon: Bug,
    operations: [{ id: "read_skill", label: "Ler a skill" }],
  },
  postgres_readonly: {
    label: "PostgreSQL readonly",
    description: "Configura uma identidade de banco dedicada somente a consultas.",
    icon: Database,
    operations: [
      { id: "describe_schema", label: "Consultar schema" },
      { id: "query_readonly", label: "Executar SELECT" },
    ],
  },
  clickhouse_readonly: {
    label: "ClickHouse readonly",
    description: "Configura acesso analítico sem mutações.",
    icon: Database,
    operations: [
      { id: "describe_schema", label: "Consultar schema" },
      { id: "query_readonly", label: "Executar SELECT" },
    ],
  },
  aws_cloudwatch: {
    label: "AWS CloudWatch",
    description: "Autoriza apenas consultas de logs e métricas nos escopos informados.",
    icon: Cloud,
    operations: [
      { id: "query_logs", label: "Consultar logs" },
      { id: "read_metrics", label: "Ler métricas" },
    ],
  },
  vercel: {
    label: "Vercel",
    description: "Autoriza leitura de deploys e logs de um projeto.",
    icon: Cloud,
    operations: [
      { id: "read_deployments", label: "Ler deploys" },
      { id: "read_logs", label: "Ler logs" },
    ],
  },
};

type ToolDraft = {
  id: string | null;
  type: LocalToolType;
  name: string;
  description: string;
  enabled: boolean;
  deepEnabled: boolean;
  allowedOperations: LocalToolOperation[];
  config: Record<string, unknown>;
  secrets: Record<string, string>;
  existingSecretFields: string[];
};

export function ToolsSettingsSection({
  tools,
  canManage,
  onChange,
  onFeedback,
}: {
  tools: LocalToolDto[];
  canManage: boolean;
  onChange(value: LocalToolDto[]): void;
  onFeedback(tone: "success" | "error", message: string): void;
}) {
  const [draft, setDraft] = useState<ToolDraft | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  function beginCreate() {
    setDraft(emptyDraft("codebase"));
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft || !canManage) return;
    setBusyId(draft.id ?? "new");
    try {
      const secrets = Object.fromEntries(
        Object.entries(draft.secrets).filter(([, value]) => value.length > 0),
      );
      const input = {
        type: draft.type,
        name: draft.name.trim(),
        description: draft.description.trim() || null,
        enabled: draft.enabled,
        deepEnabled: draft.deepEnabled,
        allowedOperations: draft.allowedOperations,
        config: draft.config,
        ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
      } as unknown as LocalToolWriteInput;
      const saved = draft.id
        ? await updateLocalTool(draft.id, input)
        : await createLocalTool(input);
      onChange(
        draft.id
          ? tools.map((tool) => (tool.id === saved.id ? saved : tool))
          : [...tools, saved],
      );
      setDraft(null);
      onFeedback(
        "success",
        draft.id
          ? "A ferramenta e seus escopos foram atualizados."
          : "A ferramenta foi criada para o Threadmark AI.",
      );
    } catch (cause) {
      onFeedback("error", errorMessage(cause));
    } finally {
      setBusyId(null);
    }
  }

  async function test(tool: LocalToolDto) {
    setBusyId(`test:${tool.id}`);
    try {
      const result = await testLocalTool(tool.id);
      onChange(await getLocalTools());
      onFeedback(result.ok ? "success" : "error", result.message);
    } catch (cause) {
      onFeedback("error", errorMessage(cause));
    } finally {
      setBusyId(null);
    }
  }

  async function toggle(tool: LocalToolDto) {
    setBusyId(tool.id);
    try {
      const saved = await updateLocalTool(tool.id, {
        enabled: !tool.enabled,
        deepEnabled: !tool.enabled,
      });
      onChange(tools.map((item) => (item.id === saved.id ? saved : item)));
      onFeedback(
        "success",
        saved.enabled ? "A ferramenta foi ativada." : "A ferramenta foi desativada.",
      );
    } catch (cause) {
      onFeedback("error", errorMessage(cause));
    } finally {
      setBusyId(null);
    }
  }

  async function remove(tool: LocalToolDto) {
    if (
      !window.confirm(
        `Excluir a ferramenta “${tool.name}”? A configuração e as credenciais locais serão removidas.`,
      )
    ) return;
    setBusyId(tool.id);
    try {
      await deleteLocalTool(tool.id);
      onChange(tools.filter((item) => item.id !== tool.id));
      if (draft?.id === tool.id) setDraft(null);
      onFeedback("success", "A ferramenta e suas credenciais locais foram excluídas.");
    } catch (cause) {
      onFeedback("error", errorMessage(cause));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="rounded-3xl border border-border bg-card p-4 shadow-sm sm:p-6 lg:p-7">
      <header className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div className="flex gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent text-primary">
            <Wrench size={18} />
          </span>
          <div>
            <h2 className="text-lg font-bold tracking-[-0.02em] text-foreground">Ferramentas locais</h2>
            <p className="mt-1 text-sm text-muted-foreground">Capacidades explicitamente autorizadas para investigações aprofundadas.</p>
          </div>
        </div>
        {canManage && !draft ? (
          <Button  onClick={beginCreate} type="button">
            <Plus size={16} /> Nova ferramenta
          </Button>
        ) : null}
      </header>

      <div className="mb-6 flex items-start gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm leading-6 text-emerald-800">
        <ShieldCheck className="mt-0.5 shrink-0 text-emerald-700" size={18} />
        <p><strong className="block text-emerald-800">Isolamento por tarefa</strong>A triagem nunca recebe estas ferramentas. Somente o Threadmark AI pode usar as operações autorizadas abaixo, sempre dentro dos limites configurados.</p>
      </div>

      {!canManage ? (
        <div className="mb-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          Somente proprietários e administradores podem alterar ferramentas locais.
        </div>
      ) : null}

      {draft ? (
        <ToolForm
          busy={busyId === (draft.id ?? "new")}
          draft={draft}
          onCancel={() => setDraft(null)}
          onChange={setDraft}
          onSubmit={save}
        />
      ) : null}

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        {tools.length === 0 ? (
          <div className="flex min-h-52 flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-muted p-6 text-center lg:col-span-2">
            <span className="grid h-11 w-11 place-items-center rounded-xl bg-card text-muted-foreground shadow-sm"><Wrench size={19} /></span>
            <h3 className="mt-3 font-semibold text-foreground">Nenhuma ferramenta autorizada</h3>
            <p className="mt-1 max-w-lg text-sm leading-6 text-muted-foreground">Uma instalação nova começa sem acesso à codebase, bancos ou serviços externos. Adicione somente o que esta equipe realmente precisa investigar.</p>
          </div>
        ) : (
          tools.map((tool) => {
            const meta = TOOL_META[tool.type];
            const Icon = meta.icon;
            return (
              <article className={`rounded-2xl border p-5 ${tool.enabled && tool.deepEnabled ? "border-primary/20 bg-accent" : "border-border bg-muted opacity-80"}`} key={tool.id}>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 gap-3">
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-card text-primary shadow-sm"><Icon size={18} /></span>
                    <div className="min-w-0">
                      <h3 className="truncate font-semibold text-foreground">{tool.name}</h3>
                      <p className="mt-0.5 text-xs font-medium text-muted-foreground">{meta.label}</p>
                    </div>
                  </div>
                  <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${tool.enabled && tool.deepEnabled ? "bg-emerald-50 text-emerald-800" : "bg-muted text-muted-foreground"}`}>
                    {tool.enabled && tool.deepEnabled ? "Ativa" : "Desativada"}
                  </span>
                </div>
                <p className="mt-4 text-sm leading-6 text-muted-foreground">{tool.description || meta.description}</p>
                <div className="mt-4 flex flex-wrap gap-1.5">
                  {tool.allowedOperations.map((operation) => (
                    <span className="inline-flex items-center gap-1 rounded-full bg-card px-2 py-1 text-xs font-semibold text-muted-foreground shadow-sm" key={operation}><Check size={11} /> {operationLabel(tool.type, operation)}</span>
                  ))}
                  {tool.secretFields.length > 0 ? <span className="rounded-full bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700">Credencial protegida</span> : null}
                </div>
                {tool.lastTestStatus ? (
                  <div className={`mt-4 flex items-start gap-2 rounded-xl p-3 text-xs leading-5 ${tool.lastTestStatus === "success" ? "bg-emerald-50 text-emerald-800" : "bg-destructive/10 text-destructive"}`}>
                    {tool.lastTestStatus === "success" ? <CheckCircle2 className="mt-0.5 shrink-0" size={14} /> : <CircleAlert className="mt-0.5 shrink-0" size={14} />}
                    <span>{tool.lastTestMessage}</span>
                  </div>
                ) : null}
                {canManage ? (
                  <div className="mt-5 flex flex-wrap gap-2 border-t border-border pt-4">
                    <Button variant="outline" disabled={busyId !== null} onClick={() => setDraft(draftFromTool(tool))} type="button">Editar</Button>
                    <Button variant="outline" disabled={busyId !== null} onClick={() => void test(tool)} type="button">{busyId === `test:${tool.id}` ? <LoaderCircle className="animate-spin" size={14} /> : <RefreshCw size={14} />} Testar</Button>
                    <Button variant="outline" disabled={busyId !== null} onClick={() => void toggle(tool)} type="button">{busyId === tool.id ? <LoaderCircle className="animate-spin" size={14} /> : <Power size={14} />} {tool.enabled ? "Desativar" : "Ativar"}</Button>
                    <Button aria-label={`Excluir ${tool.name}`} className="ml-auto" size="sm" variant="destructive" disabled={busyId !== null} onClick={() => void remove(tool)} type="button"><Trash2 size={14} /></Button>
                  </div>
                ) : null}
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}

function ToolForm({
  draft,
  busy,
  onChange,
  onCancel,
  onSubmit,
}: {
  draft: ToolDraft;
  busy: boolean;
  onChange(value: ToolDraft): void;
  onCancel(): void;
  onSubmit(event: FormEvent): void;
}) {
  const meta = TOOL_META[draft.type];
  const setConfig = (key: string, value: unknown) => onChange({
    ...draft,
    config: { ...draft.config, [key]: value },
  });
  const setSecret = (key: string, value: string) => onChange({
    ...draft,
    secrets: { ...draft.secrets, [key]: value },
  });

  return (
    <form className="rounded-xl border border-border bg-muted/30 p-4 sm:p-5" onSubmit={onSubmit}>
      <div className="mb-5 flex items-start justify-between gap-3">
        <div><h3 className="font-semibold text-foreground">{draft.id ? "Editar ferramenta" : "Autorizar nova ferramenta"}</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">Credenciais são write-only e ficam cifradas fora do SQLite.</p></div>
        <Button aria-label="Fechar formulário" className="shrink-0" onClick={onCancel} size="icon-sm" type="button" variant="ghost"><X size={16} /></Button>
      </div>
      <fieldset className="space-y-5" disabled={busy}>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Tipo" hint={meta.description}>
            <ToolSelect disabled={Boolean(draft.id)} onValueChange={(value) => onChange(emptyDraft(value as LocalToolType))} options={Object.entries(TOOL_META).map(([value, item]) => ({ value, label: item.label }))} value={draft.type} />
          </Field>
          <Field label="Nome">
            <Input className={inputClass} maxLength={120} onChange={(event) => onChange({ ...draft, name: event.target.value })} placeholder="Ex.: Código do produto" required value={draft.name} />
          </Field>
        </div>
        <Field label="Descrição" hint="Explique quando esta fonte deve ser consultada.">
          <Textarea className={`${inputClass} min-h-20 resize-y`} maxLength={1_000} onChange={(event) => onChange({ ...draft, description: event.target.value })} value={draft.description} />
        </Field>
        <ConfigFields draft={draft} setConfig={setConfig} setSecret={setSecret} />
        <div>
          <p className="text-sm font-semibold text-foreground">Operações permitidas</p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {meta.operations.map((operation) => (
              <label className="flex cursor-pointer items-center gap-2.5 rounded-xl border border-border bg-card p-3 text-xs font-medium text-foreground" key={operation.id}>
                <Checkbox checked={draft.allowedOperations.includes(operation.id)} onCheckedChange={(checked) => onChange({ ...draft, allowedOperations: checked === true ? [...draft.allowedOperations, operation.id] : draft.allowedOperations.filter((item) => item !== operation.id) })} />
                {operation.label}
              </label>
            ))}
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Toggle checked={draft.enabled} label="Ferramenta ativa" onChange={(enabled) => onChange({ ...draft, enabled })} />
          <Toggle checked={draft.deepEnabled} label="Disponível no Threadmark AI" onChange={(deepEnabled) => onChange({ ...draft, deepEnabled })} />
        </div>
      </fieldset>
      <div className="mt-5 flex flex-col-reverse gap-2 border-t border-primary/20 pt-5 sm:flex-row sm:justify-end">
        <Button className="w-full sm:w-auto" variant="outline" onClick={onCancel} type="button">Cancelar</Button>
        <Button className="w-full sm:w-auto" disabled={busy || !draft.name.trim() || (draft.deepEnabled && draft.allowedOperations.length === 0)} type="submit">{busy ? <LoaderCircle className="animate-spin" size={16} /> : <Save size={16} />} Salvar ferramenta</Button>
      </div>
    </form>
  );
}

function ConfigFields({
  draft,
  setConfig,
  setSecret,
}: {
  draft: ToolDraft;
  setConfig(key: string, value: unknown): void;
  setSecret(key: string, value: string): void;
}) {
  if (draft.type === "codebase" || draft.type === "knowledge") {
    return <Field label="Caminho absoluto da pasta" hint="O acesso concedido fica limitado a esta raiz."><Input className={inputClass} onChange={(event) => setConfig("rootPath", event.target.value)} placeholder="/Users/voce/Projects/produto" required value={stringConfig(draft, "rootPath")} /></Field>;
  }
  if (draft.type === "debugger_skill") {
    return <Field label="Caminho da skill ou do SKILL.md"><Input className={inputClass} onChange={(event) => setConfig("skillPath", event.target.value)} placeholder="/Users/voce/.codex/skills/debugger" required value={stringConfig(draft, "skillPath")} /></Field>;
  }
  if (draft.type === "postgres_readonly") {
    return <><div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3"><TextConfig draft={draft} field="host" label="Host" setConfig={setConfig} /><NumberConfig draft={draft} field="port" label="Porta" setConfig={setConfig} /><TextConfig draft={draft} field="database" label="Banco" setConfig={setConfig} /><TextConfig draft={draft} field="username" label="Usuário readonly" setConfig={setConfig} /><Field label="SSL"><ToolSelect onValueChange={(value) => setConfig("sslMode", value)} options={[{ value: "disable", label: "Desativado" }, { value: "prefer", label: "Preferir" }, { value: "require", label: "Obrigatório" }, { value: "verify-full", label: "Verificar certificado" }]} value={stringConfig(draft, "sslMode")} /></Field><SecretField draft={draft} field="password" label="Senha" setSecret={setSecret} /></div><ReadonlyWarning /></>;
  }
  if (draft.type === "clickhouse_readonly") {
    return <><div className="grid gap-4 md:grid-cols-2"><TextConfig draft={draft} field="baseUrl" label="URL HTTP(S)" setConfig={setConfig} /><TextConfig draft={draft} field="database" label="Banco" setConfig={setConfig} /><TextConfig draft={draft} field="username" label="Usuário readonly" setConfig={setConfig} /><SecretField draft={draft} field="password" label="Senha" setSecret={setSecret} /></div><ReadonlyWarning /></>;
  }
  if (draft.type === "aws_cloudwatch") {
    const accessKey = stringConfig(draft, "authMode") === "access_key";
    return <><div className="grid gap-4 md:grid-cols-2"><TextConfig draft={draft} field="region" label="Região" setConfig={setConfig} /><Field label="Autenticação"><ToolSelect onValueChange={(value) => setConfig("authMode", value)} options={[{ value: "profile", label: "Perfil local da AWS" }, { value: "access_key", label: "Access key dedicada" }]} value={stringConfig(draft, "authMode")} /></Field>{accessKey ? <><SecretField draft={draft} field="accessKeyId" label="Access Key ID" required setSecret={setSecret} /><SecretField draft={draft} field="secretAccessKey" label="Secret Access Key" required setSecret={setSecret} /><SecretField draft={draft} field="sessionToken" label="Session token opcional" setSecret={setSecret} /></> : <TextConfig draft={draft} field="profile" label="Perfil AWS" setConfig={setConfig} />}</div><Field label="Prefixos de log groups" hint="Um por linha. Pelo menos um prefixo é obrigatório para impedir acesso amplo à conta."><Textarea className={`${inputClass} min-h-24 resize-y`} onChange={(event) => setConfig("logGroupPrefixes", event.target.value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))} required value={arrayConfig(draft, "logGroupPrefixes").join("\n")} /></Field><ReadonlyWarning /></>;
  }
  return <><div className="grid gap-4 md:grid-cols-2"><TextConfig draft={draft} field="teamId" label="Team ID opcional" required={false} setConfig={setConfig} /><TextConfig draft={draft} field="projectId" label="Project ID" setConfig={setConfig} /><SecretField draft={draft} field="token" label="Token readonly" required setSecret={setSecret} /></div><ReadonlyWarning /></>;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="block min-w-0 max-w-full text-xs font-medium text-foreground">{label}{children}{hint ? <span className="mt-1.5 block text-xs font-normal leading-5 text-muted-foreground">{hint}</span> : null}</label>;
}

function ToolSelect({ value, options, disabled = false, onValueChange }: { value: string; options: Array<{ value: string; label: string }>; disabled?: boolean; onValueChange(value: string): void }) {
  return <Select disabled={disabled} onValueChange={onValueChange} value={value}><SelectTrigger className={inputClass}><SelectValue /></SelectTrigger><SelectContent>{options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select>;
}

function TextConfig({ draft, field, label, setConfig, required = true }: { draft: ToolDraft; field: string; label: string; setConfig(key: string, value: unknown): void; required?: boolean }) {
  return <Field label={label}><Input className={inputClass} onChange={(event) => setConfig(field, event.target.value || (required ? "" : null))} required={required} value={stringConfig(draft, field)} /></Field>;
}

function NumberConfig({ draft, field, label, setConfig }: { draft: ToolDraft; field: string; label: string; setConfig(key: string, value: unknown): void }) {
  return <Field label={label}><Input className={inputClass} max={65535} min={1} onChange={(event) => setConfig(field, Number(event.target.value))} required type="number" value={numberConfig(draft, field)} /></Field>;
}

function SecretField({ draft, field, label, setSecret, required = false }: { draft: ToolDraft; field: string; label: string; setSecret(key: string, value: string): void; required?: boolean }) {
  const configured = draft.existingSecretFields.includes(field);
  return <Field label={label} hint={configured ? "Já configurada. Deixe vazio para preservar ou informe uma nova para substituir." : "Salva no cofre local e nunca devolvida pela API."}><Input autoComplete="new-password" className={inputClass} onChange={(event) => setSecret(field, event.target.value)} placeholder={configured ? "Credencial protegida" : "Informe a credencial"} required={required && !configured} type="password" value={draft.secrets[field] ?? ""} /></Field>;
}

function Toggle({ checked, label, onChange }: { checked: boolean; label: string; onChange(value: boolean): void }) {
  return <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-border bg-card p-3 text-xs font-medium text-foreground"><Checkbox checked={checked} onCheckedChange={(value) => onChange(value === true)} />{label}</label>;
}

function ReadonlyWarning() {
  return <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-800"><CircleAlert className="mt-0.5 shrink-0" size={14} /><span>Use uma identidade tecnicamente readonly. O Threadmark valida o cadastro, mas não transforma uma credencial com escrita em somente leitura.</span></div>;
}

function emptyDraft(type: LocalToolType): ToolDraft {
  const config: Record<string, unknown> = {
    codebase: { rootPath: "" },
    knowledge: { rootPath: "" },
    debugger_skill: { skillPath: "" },
    postgres_readonly: { host: "", port: 5432, database: "", username: "", sslMode: "require" },
    clickhouse_readonly: { baseUrl: "https://", database: "default", username: "readonly" },
    aws_cloudwatch: { region: "us-east-1", authMode: "profile", profile: "default", logGroupPrefixes: [] },
    vercel: { teamId: null, projectId: null },
  }[type] as Record<string, unknown>;
  return {
    id: null,
    type,
    name: "",
    description: "",
    enabled: true,
    deepEnabled: true,
    allowedOperations: TOOL_META[type].operations.map((item) => item.id),
    config,
    secrets: {},
    existingSecretFields: [],
  };
}

function draftFromTool(tool: LocalToolDto): ToolDraft {
  return {
    id: tool.id,
    type: tool.type,
    name: tool.name,
    description: tool.description ?? "",
    enabled: tool.enabled,
    deepEnabled: tool.deepEnabled,
    allowedOperations: [...tool.allowedOperations],
    config: { ...(tool.config as unknown as Record<string, unknown>) },
    secrets: {},
    existingSecretFields: [...tool.secretFields],
  };
}

function stringConfig(draft: ToolDraft, field: string): string {
  const value = draft.config[field];
  return typeof value === "string" ? value : "";
}

function numberConfig(draft: ToolDraft, field: string): number {
  const value = draft.config[field];
  return typeof value === "number" ? value : 0;
}

function arrayConfig(draft: ToolDraft, field: string): string[] {
  const value = draft.config[field];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function operationLabel(type: LocalToolType, operation: LocalToolOperation): string {
  return TOOL_META[type].operations.find((item) => item.id === operation)?.label ?? operation;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Ocorreu um erro inesperado.";
}
