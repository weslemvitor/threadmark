"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, CheckCircle2, Copy, LoaderCircle, Plus, X } from "lucide-react";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Textarea } from "@/app/components/ui/textarea";
import { Checkbox } from "@/app/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/app/components/ui/select";
import { API_URL, createChannel, previewChannel, setChannelStatus, updateChannel } from "@/app/lib/api";
import type { ClientSummary } from "@/app/lib/types";
import { CHANNEL_EVENT_TYPES, type ChannelConfig, type ChannelConnection, type ChannelMappingField, type ChannelMessageEvent } from "@/shared/channels";
import { CHANNEL_DEFAULT_CONFIG, CHANNEL_FIELDS, CHANNEL_SAMPLE, channelSamplePaths, channelSetupError, channelValueAt, channelValueLabel, parseChannelSample } from "../../domain/channel-setup";
import { Field, Notice, formatDate } from "../settings-support";

type Pair = {value: string; target: string};
const STEPS = ["Identificar", "Entender a mensagem", "Proteger a conexão", "Revisar e ativar"];
const ROLE_CHOICES = [{value: "customer", label: "Cliente — entra na triagem"}, {value: "support", label: "Equipe — fica como contexto"}];
const EVENT_CHOICES = [{value: "message.created", label: "Nova mensagem"}, {value: "message.updated", label: "Mensagem editada"}, {value: "message.deleted", label: "Mensagem excluída"}];

function Choice({label, hint, value, items, onChange}: {
  label: string; hint?: string; value: string; items: Array<{value: string; label: string}>; onChange: (value: string) => void;
}) {
  return <Field label={label} hint={hint}><Select value={value} onValueChange={onChange}><SelectTrigger aria-label={label} className="mt-2 w-full"><SelectValue placeholder="Escolha uma opção"/></SelectTrigger><SelectContent>{items.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent></Select></Field>;
}

function Correspondences({label, hint, rows, choices, onChange}: {
  label: string; hint: string; rows: Pair[]; choices: Array<{value: string; label: string}>; onChange: (rows: Pair[]) => void;
}) {
  return <fieldset className="grid gap-3 rounded-xl border border-border p-4"><legend className="px-1 text-sm font-semibold">{label}</legend><p className="text-sm text-muted-foreground">{hint}</p>
    {rows.map((row, index) => <div key={index} className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_auto]">
      <Field label="Valor recebido"><Input className="mt-2" aria-label={`${label}: valor recebido ${index + 1}`} value={row.value} onChange={event => onChange(rows.map((item, position) => position === index ? {...item, value: event.target.value} : item))}/></Field>
      <Choice label={`${label}: interpretar como ${index + 1}`} value={row.target} items={choices} onChange={target => onChange(rows.map((item, position) => position === index ? {...item, target} : item))}/>
      <Button type="button" variant="ghost" size="icon" aria-label={`Remover ${label.toLowerCase()} ${index + 1}`} onClick={() => onChange(rows.filter((_, position) => position !== index))}><X size={16}/></Button>
    </div>)}
    <Button type="button" size="sm" variant="outline" className="w-fit" onClick={() => onChange([...rows, {value: "", target: ""}])}><Plus size={14}/>Adicionar correspondência</Button>
  </fieldset>;
}

function pairRecord(rows: Pair[], label: string): Record<string, string> {
  const present = rows.filter(row => row.value.trim() || row.target);
  if (present.some(row => !row.value.trim() || !row.target)) throw new Error(`Complete o valor recebido e sua interpretação em ${label}.`);
  if (new Set(present.map(row => row.value.trim())).size !== present.length) throw new Error(`Há valores recebidos repetidos em ${label}.`);
  return Object.fromEntries(present.map(row => [row.value.trim(), row.target]));
}

export function channelWebhookUrl(connection: ChannelConnection): string {
  if (typeof window === "undefined") return connection.webhookPath;
  return new URL(connection.webhookPath, new URL(API_URL || "/", window.location.origin)).toString();
}

export function ChannelSetupWizard({connection, clients, onClose, onSaved}: {
  connection?: ChannelConnection; clients: ClientSummary[]; onClose: () => void;
  onSaved: (connection: ChannelConnection, token?: string | null) => Promise<void>;
}) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState(connection?.name ?? "");
  const [description, setDescription] = useState(connection?.description ?? "");
  const [clientId, setClientId] = useState(connection?.clientId ?? "");
  const [config, setConfig] = useState<ChannelConfig>(() => ({...structuredClone(CHANNEL_DEFAULT_CONFIG), ...structuredClone(connection?.config ?? {}),
    authentication: connection?.config.authentication === "hmac_sha256" ? "hmac" : connection?.config.authentication ?? "bearer"}));
  const [sample, setSample] = useState("");
  const [sampleIsDemo, setSampleIsDemo] = useState(false);
  const [roles, setRoles] = useState<Pair[]>(Object.entries(connection?.config.roleMapping ?? {}).map(([value, target]) => ({value, target})));
  const [eventTypes, setEventTypes] = useState<Pair[]>(Object.entries(connection?.config.eventTypeMapping ?? {}).map(([value, target]) => ({value, target})));
  const [signatureSecret, setSignatureSecret] = useState("");
  const [saved, setSaved] = useState<ChannelConnection | null>(connection ?? null);
  const [preview, setPreview] = useState<ChannelMessageEvent | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const wizardRef = useRef<HTMLElement>(null);
  const parsed = useMemo(() => parseChannelSample(sample), [sample]);
  const paths = useMemo(() => channelSamplePaths(parsed.payload), [parsed.payload]);
  useEffect(() => {wizardRef.current?.scrollIntoView({block: "start"});}, [step]);

  function changeConfig(next: Partial<ChannelConfig>) { setConfig(current => ({...current, ...next})); setPreview(null); }
  function changeSample(value: string, demo = false) { setSample(value); setSampleIsDemo(demo); setPreview(null); setError(null); }
  function mapField(key: ChannelMappingField, path: string) {
    const mapping = {...config.mapping};
    if (path) mapping[key] = path; else delete mapping[key];
    const next: Partial<ChannelConfig> = {mapping};
    const value = channelValueAt(parsed.payload, path);
    if (key === "occurredAt" && typeof value === "number") next.timestampFormat = Math.abs(value) < 100_000_000_000 ? "unix_seconds" : "unix_milliseconds";
    if (key === "authorRole" && typeof value === "string" && !["customer", "support"].includes(value) && !roles.some(row => row.value === value)) setRoles(current => [...current, {value, target: ""}]);
    if (key === "eventType" && typeof value === "string" && !CHANNEL_EVENT_TYPES.includes(value as typeof CHANNEL_EVENT_TYPES[number]) && !eventTypes.some(row => row.value === value)) setEventTypes(current => [...current, {value, target: ""}]);
    changeConfig(next);
  }
  function checkSample() {
    if (parsed.error) throw new Error(parsed.error);
    if (!parsed.payload) throw new Error("Cole uma mensagem de exemplo para continuar.");
    if (config.format === "mapped") {
      const missing = ["eventId", "messageId", "conversationId", "occurredAt"].filter(key => !config.mapping[key as ChannelMappingField]);
      if (missing.length) throw new Error(`Escolha os campos obrigatórios: ${missing.map(key => CHANNEL_FIELDS.find(field => field.key === key)?.label).join(", ")}.`);
    }
  }
  async function perform(action: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await action(); } catch (cause) { setError(channelSetupError(cause)); } finally { setBusy(false); }
  }
  async function validateMessage() {
    checkSample();
    if (config.authentication !== "bearer" && !signatureSecret && (!saved || saved.config.authentication === "bearer")) throw new Error("Informe a chave de assinatura do aplicativo que envia as mensagens.");
    const input = {name: name.trim(), description, clientId: clientId || null,
      config: {...config, roleMapping: pairRecord(roles, "papéis dos autores") as ChannelConfig["roleMapping"], eventTypeMapping: pairRecord(eventTypes, "tipos de evento") as ChannelConfig["eventTypeMapping"]},
      ...(signatureSecret ? {signatureSecret} : {}),
    };
    let current: ChannelConnection;
    if (saved) {
      current = await updateChannel(saved.id, input); setSaved(current); setSignatureSecret(""); await onSaved(current);
    } else {
      const created = await createChannel(input); current = created.connection; setSaved(current); setSignatureSecret(""); await onSaved(current, created.token);
    }
    const result = await previewChannel(current.id, parsed.payload);
    setPreview(result.event); setStep(3); await onSaved({...current, lastPreviewAt: new Date().toISOString()});
  }
  function mappingFields(optional: boolean) {
    return CHANNEL_FIELDS.filter(field => Boolean(field.optional) === optional).map(field => <Field key={field.key} label={`${field.label} (${field.key})`} hint={field.hint}>
      <Select value={config.mapping[field.key] ? `path:${config.mapping[field.key]}` : "none"} onValueChange={value => mapField(field.key, value === "none" ? "" : value.slice(5))}>
        <SelectTrigger aria-label={`Campo: ${field.label}`} className="mt-2 w-full min-w-0"><SelectValue/></SelectTrigger><SelectContent>
          <SelectItem value="none">Escolha um campo do exemplo</SelectItem>
          {[...new Set([...paths, ...(config.mapping[field.key] ? [config.mapping[field.key]!] : [])])].map(path => <SelectItem key={path} value={`path:${path}`}>{path}</SelectItem>)}
        </SelectContent>
      </Select>
      {config.mapping[field.key] ? <span className="mt-1 block break-words text-xs font-normal text-muted-foreground">Valor: {channelValueLabel(channelValueAt(parsed.payload, config.mapping[field.key]))}</span> : null}
    </Field>);
  }

  return <section ref={wizardRef} className="mb-6 min-w-0 scroll-mt-32 rounded-xl border border-primary/25 bg-muted/15" aria-label="Configuração guiada do canal">
    <header className="flex items-start justify-between gap-3 border-b border-border p-4 sm:p-5"><div><h3 className="font-semibold">{connection ? `Configurar ${connection.name}` : "Conectar novo canal"}</h3><p className="mt-1 text-sm text-muted-foreground">Uma mensagem de exemplo ajuda a conferir como os dados vão aparecer no atendimento.</p></div><Button type="button" variant="ghost" size="icon" disabled={busy} aria-label="Fechar configuração" onClick={onClose}><X size={17}/></Button></header>
    <ol className="grid grid-cols-2 gap-3 border-b border-border p-4 sm:grid-cols-4 sm:p-5" aria-label="Etapas da conexão">{STEPS.map((label, index) => <li key={label} aria-current={step === index ? "step" : undefined} className={`flex min-w-0 items-center gap-2 text-xs ${step === index ? "font-semibold text-primary" : "text-muted-foreground"}`}><span className={`grid size-7 shrink-0 place-items-center rounded-full border ${index <= step ? "border-primary/30 bg-primary/10 text-primary" : "border-border"}`}>{index < step ? <Check size={14}/> : index + 1}</span><span>{label}</span></li>)}</ol>
    <form onSubmit={event => event.preventDefault()}><fieldset disabled={busy} className="grid min-w-0 gap-5 p-4 sm:p-5">
      {error ? <Notice tone="error" title="Confira a configuração">{error}</Notice> : null}
      {step === 0 ? <>
        <div><h4 className="font-semibold">Como você quer identificar este canal?</h4><p className="mt-1 text-sm text-muted-foreground">Use um nome que sua equipe reconheça nas conversas e no Kanban.</p></div>
        <Field label="Nome do canal"><Input className="mt-2" value={name} maxLength={120} placeholder="Ex.: Atendimento do site" onChange={event => {setName(event.target.value); setPreview(null);}} autoFocus/></Field>
        <Choice label="Cliente das novas conversas" hint="Você pode deixar a identificação para a triagem. Conversas já vinculadas preservam o cliente atual." value={clientId || "unassigned"} items={[{value: "unassigned", label: "Identificar durante a triagem"}, ...clients.filter(client => !client.isUnidentified).map(client => ({value: client.id, label: client.name}))]} onChange={value => {setClientId(value === "unassigned" ? "" : value); setPreview(null);}}/>
        <Choice label="Como as conversas são organizadas na origem?" value={config.conversationScope} items={[{value: "group", label: "Grupos, canais ou tópicos"}, {value: "direct", label: "Atendimentos individuais"}]} onChange={value => changeConfig({conversationScope: value as ChannelConfig["conversationScope"]})}/>
        <label className="flex items-start gap-2 text-sm"><Checkbox checked={config.monitored} onCheckedChange={checked => changeConfig({monitored: checked === true})}/><span>Incluir mensagens de clientes na triagem<span className="mt-1 block text-xs text-muted-foreground">Mensagens da equipe ficam como contexto. Receber uma mensagem não cria um chamado automaticamente.</span></span></label>
        <details><summary className="cursor-pointer text-sm text-muted-foreground">Adicionar descrição (opcional)</summary><Input aria-label="Descrição do canal" className="mt-3" value={description} maxLength={1000} onChange={event => {setDescription(event.target.value); setPreview(null);}}/></details>
      </> : null}
      {step === 1 ? <>
        <div><h4 className="font-semibold">Mostre uma mensagem que o sistema envia</h4><p className="mt-1 text-sm text-muted-foreground">Cole o corpo JSON de um evento real ou use um exemplo demonstrativo para conhecer o fluxo.</p></div>
        <div className="grid gap-3 sm:grid-cols-2">{[{value: "standard", label: "O remetente usa o formato Threadmark", detail: "Os campos já seguem o contrato da aplicação."}, {value: "mapped", label: "O remetente envia outro JSON", detail: "Escolha onde estão os dados no exemplo."}].map(item => <Button key={item.value} type="button" variant="outline" aria-pressed={config.format === item.value} className={`h-auto justify-start whitespace-normal p-4 text-left ${config.format === item.value ? "border-primary bg-primary/5" : ""}`} onClick={() => changeConfig({format: item.value as ChannelConfig["format"]})}><span><strong className="block text-sm">{item.label}</strong><span className="mt-1 block text-xs font-normal text-muted-foreground">{item.detail}</span></span></Button>)}</div>
        <Field label="Mensagem de exemplo (JSON)" hint="Cole apenas o corpo do evento, sem cabeçalhos ou credenciais. Este exemplo não entra na operação."><Textarea className="mt-2 min-h-52 font-mono text-xs" value={sample} placeholder={'{\n  "id": "event-123",\n  "data": { ... }\n}'} onChange={event => changeSample(event.target.value)}/></Field>
        <div className="flex flex-wrap items-center gap-2"><Button size="sm" type="button" variant="outline" onClick={() => {changeSample(CHANNEL_SAMPLE, true); setRoles([]); setEventTypes([]); changeConfig({format: "standard", mapping: {}});}}>Usar exemplo demonstrativo</Button>{sampleIsDemo ? <span className="text-xs text-muted-foreground">Exemplo demonstrativo — não comprova conexão com o remetente.</span> : null}</div>
        {parsed.error ? <p role="alert" className="text-sm text-destructive">{parsed.error}</p> : null}
        {config.format === "mapped" && parsed.payload ? <>
          <div><h4 className="font-semibold">Escolha os campos do exemplo</h4><p className="mt-1 text-sm text-muted-foreground">Cada seleção mostra o valor encontrado. Confira principalmente os IDs e quem escreveu a mensagem.</p></div>
          <div className="grid gap-4 sm:grid-cols-2">{mappingFields(false)}</div>
          <Correspondences label="Papéis dos autores" hint="Se a origem usa outros nomes, indique quais são clientes e quais são integrantes da equipe." rows={roles} choices={ROLE_CHOICES} onChange={next => {setRoles(next); setPreview(null);}}/>
          <details className="rounded-xl border border-border p-4"><summary className="cursor-pointer text-sm font-medium">Mais campos e tipos de evento (opcional)</summary><div className="mt-4 grid gap-4 sm:grid-cols-2">{mappingFields(true)}</div><div className="mt-4"><Correspondences label="Tipos de evento" hint="Relacione os valores enviados pela origem com criação, edição ou exclusão de uma mensagem." rows={eventTypes} choices={EVENT_CHOICES} onChange={next => {setEventTypes(next); setPreview(null);}}/></div></details>
        </> : null}
        <Choice label="Formato das datas no JSON" value={config.timestampFormat} items={[{value: "iso", label: "Texto com data e fuso (ISO 8601)"}, {value: "unix_seconds", label: "Número Unix em segundos"}, {value: "unix_milliseconds", label: "Número Unix em milissegundos"}]} onChange={value => changeConfig({timestampFormat: value as ChannelConfig["timestampFormat"]})}/>
      </> : null}
      {step === 2 ? <>
        <div><h4 className="font-semibold">Como o remetente comprova a origem da mensagem?</h4><p className="mt-1 text-sm text-muted-foreground">Use a opção disponível na configuração de webhook do sistema que vai enviar os dados.</p></div>
        <Choice label="Forma de autenticação" value={config.authentication} items={[{value: "bearer", label: "Token — posso configurar o cabeçalho Authorization"}, {value: "hmac", label: "Assinatura — o sistema já assina seus webhooks"}]} onChange={value => changeConfig({authentication: value as ChannelConfig["authentication"]})}/>
        {config.authentication === "bearer" ? <p className="rounded-lg bg-muted p-4 text-sm text-muted-foreground">O Threadmark {saved ? "mantém o token atual" : "gera um token exclusivo"}. No remetente, configure o cabeçalho <code>Authorization: Bearer &lt;token&gt;</code>. A URL fica disponível após validar a mensagem.</p> : <>
          <Field label="Chave de assinatura do aplicativo remetente" hint={saved?.config.authentication !== "bearer" && saved ? "Deixe vazio para manter a chave já configurada." : "Use a chave que assina os webhooks (client secret). Ela é diferente de um token de acesso à API; mínimo de 32 caracteres."}><Input className="mt-2" type="password" autoComplete="new-password" value={signatureSecret} onChange={event => {setSignatureSecret(event.target.value); setPreview(null);}}/></Field>
          <div className="grid gap-4 sm:grid-cols-2"><Field label="Cabeçalho da assinatura" hint="Copie o nome informado na documentação do remetente."><Input className="mt-2" value={config.signatureHeader} onChange={event => changeConfig({signatureHeader: event.target.value})}/></Field>
            <Choice label="Algoritmo da assinatura" value={config.signatureAlgorithm ?? "sha256"} items={[{value: "sha256", label: "HMAC-SHA256"}, {value: "sha1", label: "HMAC-SHA1 (quando exigido pela origem)"}]} onChange={value => changeConfig({signatureAlgorithm: value as "sha256" | "sha1"})}/>
            <Choice label="Codificação da assinatura" value={config.signatureEncoding} items={[{value: "hex", label: "Hexadecimal"}, {value: "base64", label: "Base64"}]} onChange={value => changeConfig({signatureEncoding: value as "hex" | "base64"})}/>
            <Field label="Prefixo da assinatura (opcional)" hint="Texto antes da assinatura, se a origem usar um prefixo como sha256=."><Input className="mt-2" value={config.signaturePrefix ?? ""} onChange={event => changeConfig({signaturePrefix: event.target.value})}/></Field></div>
        </>}
        <p className="text-sm text-muted-foreground">Ao validar, a configuração será salva como desativada. A prévia confere os campos; a autenticação de um envio real será conferida pelo endpoint de recebimento.</p>
        {saved?.status === "active" ? <Notice tone="warning" title="O canal voltará à configuração">Salvar desativa o recebimento até você conferir a nova prévia e ativar novamente.</Notice> : null}
      </> : null}
      {step === 3 && preview && saved ? <>
        <Notice tone="success" title="Formato da mensagem validado">Confira o resultado abaixo. Nenhuma mensagem ou chamado foi criado por esta prévia.</Notice>
        <div className="rounded-xl border border-border bg-card p-4"><div className="mb-3 flex items-center gap-2 text-sm font-semibold"><CheckCircle2 size={17} className="text-primary"/>Prévia no atendimento</div><dl className="grid gap-3 text-sm sm:grid-cols-2">{[{label: "Conversa", value: preview.conversationTitle ?? preview.conversationId}, {label: "Autor", value: preview.authorName ?? "Mensagem existente"}, {label: "Papel", value: preview.authorRole === "support" ? "Equipe — contexto" : preview.authorRole === "customer" ? "Cliente — triagem" : "Preservado da mensagem original"}, {label: "Data", value: formatDate(preview.occurredAt)}, {label: "Evento", value: EVENT_CHOICES.find(item => item.value === preview.eventType)?.label ?? preview.eventType}].map(item => <div key={item.label}><dt className="text-xs text-muted-foreground">{item.label}</dt><dd className="mt-1 break-words font-medium">{item.value}</dd></div>)}</dl><p className="mt-4 whitespace-pre-wrap break-words rounded-lg bg-muted p-3 text-sm">{preview.eventType === "message.deleted" ? "[Mensagem excluída na origem]" : preview.body ?? "Mensagem com anexos"}</p>{preview.eventType !== "message.deleted" && preview.attachments.length ? <p className="mt-2 text-xs text-muted-foreground">{preview.attachments.length} referência(s) a anexos</p> : null}</div>
        <div><h4 className="font-semibold">Configure o envio no sistema de origem</h4><p className="mt-1 text-sm text-muted-foreground">Cadastre um webhook com método POST para esta URL e envie o corpo como JSON.</p><div className="mt-3 flex min-w-0 gap-2"><Input aria-label="URL de recebimento" readOnly value={channelWebhookUrl(saved)}/><Button type="button" variant="outline" aria-label="Copiar URL de recebimento" onClick={() => void perform(async () => {await navigator.clipboard.writeText(channelWebhookUrl(saved)); setCopied(true);})}>{copied ? <Check size={15}/> : <Copy size={15}/>}</Button></div>
          {config.authentication !== "bearer" ? <p className="mt-2 break-all text-xs text-muted-foreground">Cabeçalho esperado: <code>{config.signatureHeader}: {config.signaturePrefix ?? ""}&lt;assinatura&gt;</code></p> : null}
          {/\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/)/.test(channelWebhookUrl(saved)) ? <p className="mt-3 text-sm text-amber-700 dark:text-amber-400">Esta URL é local. Para receber de um sistema externo, a instalação precisa de uma URL HTTPS acessível por ele.</p> : null}
        </div>
        <p className="text-sm text-muted-foreground">Depois de ativar, faça um envio pela origem e confira <strong>Ver recebimentos</strong>. A prévia validada e a entrega real são confirmações diferentes.</p>
      </> : null}
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4"><Button type="button" variant="outline" disabled={busy} onClick={() => {setError(null); if (step > 0) setStep(step - 1); else onClose();}}><ArrowLeft size={15}/>{step > 0 ? "Voltar" : "Cancelar"}</Button>
        {step < 2 ? <Button type="button" disabled={busy} onClick={() => {setError(null); try {if (step === 0 && !name.trim()) throw new Error("Informe um nome para o canal."); if (step === 1) checkSample(); setStep(step + 1);} catch (cause) {setError(channelSetupError(cause));}}}>Continuar<ArrowRight size={15}/></Button> : step === 2 ? <Button type="button" disabled={busy} onClick={() => void perform(validateMessage)}>{busy ? <LoaderCircle size={15} className="animate-spin"/> : null}Salvar e validar mensagem</Button> : <Button type="button" disabled={busy || !preview || !saved} onClick={() => void perform(async () => {if (!saved) return; const active = await setChannelStatus(saved.id, "active"); await onSaved(active); onClose();})}>{busy ? <LoaderCircle size={15} className="animate-spin"/> : <Check size={15}/>}Ativar e receber mensagens</Button>}
      </footer>
    </fieldset></form>
  </section>;
}
