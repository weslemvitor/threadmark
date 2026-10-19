"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowRight, Check, Copy, LoaderCircle, Plus, Radio, RefreshCw } from "lucide-react";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Card } from "@/app/components/ui/card";
import { getChannels, getChannelEvents, getClients, retryChannelEvent, rotateChannelToken, setChannelStatus } from "@/app/lib/api";
import type { ChannelConnection, ChannelEventRecord } from "@/shared/channels";
import type { ClientSummary } from "@/app/lib/types";
import { channelSetupError } from "../../domain/channel-setup";
import { Field, Notice, PermissionNotice, SectionLayout, formatDate } from "../settings-support";
import { ChannelSetupWizard, channelWebhookUrl } from "./channel-setup-wizard";

const statusLabel = {draft: "Em configuração", active: "Ativo", paused: "Pausado"};
const stateLabel = {pending: "Na fila", processing: "Processando", processed: "Processado", failed: "Falha"};
const errorLabel: Record<string, string> = {
  channel_message_missing: "A mensagem original ainda não chegou. Reprocesse após recebê-la.",
  channel_processing_failed: "Não foi possível processar. Revise a configuração antes de reprocessar.",
};

export function ChannelsSection({canManage}: {canManage: boolean}) {
  const [connections, setConnections] = useState<ChannelConnection[]>([]);
  const [clients, setClients] = useState<ClientSummary[]>([]);
  const [editor, setEditor] = useState<ChannelConnection | null | undefined>(undefined);
  const [credential, setCredential] = useState<{id: string; name: string; token: string} | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [events, setEvents] = useState<ChannelEventRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [channels, nextClients] = await Promise.all([getChannels(), getClients()]);
    setConnections(channels); setClients(nextClients);
  }, []);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const [channels, nextClients, nextEvents] = await Promise.all([getChannels(), getClients(), selected && canManage ? getChannelEvents(selected) : Promise.resolve([])]);
        if (active) {setConnections(channels); setClients(nextClients); setEvents(nextEvents);}
      } catch (cause) {if (active) setError(channelSetupError(cause));}
      finally {if (active) setLoading(false);}
    };
    void refresh(); const timer = window.setInterval(() => void refresh(), 5000);
    return () => {active = false; window.clearInterval(timer);};
  }, [selected, canManage]);

  async function run(action: () => Promise<void>) {
    setBusy(true); setError(null); setFeedback(null);
    try {await action(); await load();} catch (cause) {setError(channelSetupError(cause));} finally {setBusy(false);}
  }
  async function copy(value: string, key: string) {
    try {await navigator.clipboard.writeText(value); setCopied(key);}
    catch {setError("Não foi possível copiar. Selecione o campo e copie manualmente.");}
  }
  async function saved(connection: ChannelConnection, token?: string | null) {
    if (token) setCredential({id: connection.id, name: connection.name, token});
    setSelected(connection.id); setEvents([]); await load();
    if (connection.status === "active") setFeedback("Canal ativado. Faça um envio pelo sistema de origem e confira o recebimento abaixo.");
  }
  const selectedConnection = connections.find(item => item.id === selected);

  return <SectionLayout title="Canais de coleta" description="Receba mensagens de outros sistemas no mesmo fluxo de conversas, triagem e chamados." icon={Radio}
    action={canManage ? <Button disabled={busy || editor !== undefined} onClick={() => {setEditor(null); setError(null); setFeedback(null);}}><Plus size={15}/>Conectar novo canal</Button> : undefined}>
    {!canManage ? <PermissionNotice/> : null}
    {error ? <div className="mb-4"><Notice tone="error" title="Não foi possível concluir">{error}</Notice></div> : null}
    {feedback ? <div className="mb-4"><Notice tone="success" title="Configuração atualizada">{feedback}</Notice></div> : null}
    <Card className="mb-4 gap-2 p-4"><div className="flex items-center justify-between gap-3"><strong className="text-sm">WhatsApp</strong><span className="text-xs text-muted-foreground">Conexão nativa</span></div><p className="text-sm text-muted-foreground">Sua conexão com sessão e QR code continua sendo gerenciada na área do WhatsApp.</p><Link className="inline-flex w-fit items-center gap-1 text-sm font-medium text-primary underline-offset-4 hover:underline" href="/settings/whatsapp">Gerenciar WhatsApp<ArrowRight size={14}/></Link></Card>
    {credential ? <div className="mb-4 rounded-xl border border-primary/20 bg-primary/5 p-4"><strong className="text-sm">Token de {credential.name}</strong><p className="mt-1 text-sm text-muted-foreground">Copie e guarde o token antes de sair. No sistema de origem, configure o cabeçalho Authorization com o valor Bearer seguido deste token.</p><div className="mt-3 flex min-w-0 gap-2"><Input readOnly aria-label="Token do canal" type="password" value={credential.token}/><Button aria-label="Copiar token do canal" variant="outline" onClick={() => void copy(credential.token, "token")}>{copied === "token" ? <Check size={15}/> : <Copy size={15}/>}</Button></div></div> : null}
    {canManage && editor !== undefined ? <ChannelSetupWizard key={editor?.id ?? "new"} connection={editor ?? undefined} clients={clients} onClose={() => setEditor(undefined)} onSaved={saved}/> : null}
    {loading ? <p className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="animate-spin" size={16}/>Carregando canais…</p> : null}
    {!loading && !connections.length && editor === undefined ? <div className="mb-4 rounded-xl border border-dashed border-border p-5"><h3 className="font-semibold">Conecte seu primeiro canal de mensagens</h3><p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">O sistema de origem precisa enviar eventos por webhook (HTTP com JSON). Você configura uma vez como reconhecer a conversa, a mensagem e o autor.</p><ol className="mt-4 grid gap-3 text-sm text-muted-foreground sm:grid-cols-3"><li><strong className="block text-foreground">1. Cole um exemplo</strong>Use uma mensagem que a origem envia.</li><li><strong className="block text-foreground">2. Confira os campos</strong>Veja o texto, o autor e a conversa na prévia.</li><li><strong className="block text-foreground">3. Ative e receba</strong>Cadastre a URL na origem e confirme o primeiro envio.</li></ol></div> : null}
    <div className="grid gap-3">{connections.map(connection => <Card className="gap-3 p-4" key={connection.id}>
      <div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0"><strong className="break-words text-sm">{connection.name}</strong><p className="mt-1 text-xs text-muted-foreground">{connection.description || "Canal de coleta de mensagens"}</p></div><span className={`rounded-full px-2 py-1 text-xs ${connection.status === "active" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}>{statusLabel[connection.status]}</span></div>
      {canManage ? <Field label="URL de recebimento"><div className="mt-2 flex min-w-0 gap-2"><Input readOnly aria-label={`URL de ${connection.name}`} value={channelWebhookUrl(connection)}/><Button size="icon" variant="outline" aria-label={`Copiar URL de ${connection.name}`} onClick={() => void copy(channelWebhookUrl(connection), connection.id)}>{copied === connection.id ? <Check size={15}/> : <Copy size={15}/>}</Button></div></Field> : null}
      <p className="text-xs text-muted-foreground">{connection.lastReceivedAt ? `Último evento recebido: ${formatDate(connection.lastReceivedAt)}` : connection.status === "active" ? "Aguardando o primeiro envio do sistema de origem." : "Nenhum evento recebido da origem."} · {connection.pendingCount} na fila · {connection.failedCount} com falha</p>
      {connection.failedCount > 0 || connection.lastError ? <p className="text-xs text-destructive">Há recebimentos que precisam de revisão. Abra o histórico para conferir.</p> : null}
      {canManage ? <div className="flex flex-wrap gap-2"><Button disabled={busy || editor !== undefined} size="sm" variant="outline" onClick={() => {setEditor(connection); setError(null);}}>Configurar</Button><Button disabled={busy || (connection.status === "draft" && !connection.lastPreviewAt)} size="sm" variant="outline" onClick={() => void run(async () => {const next = await setChannelStatus(connection.id, connection.status === "active" ? "paused" : "active"); setFeedback(next.status === "active" ? "Canal ativado. Confira o próximo envio no histórico de recebimentos." : "Canal pausado. O histórico foi preservado.");})}>{connection.status === "active" ? "Pausar" : "Ativar"}</Button><Button disabled={busy} size="sm" variant="ghost" onClick={() => {setEvents([]); setSelected(selected === connection.id ? null : connection.id);}}>Ver recebimentos</Button>{connection.config.authentication === "bearer" ? <Button disabled={busy} size="sm" variant="ghost" onClick={() => void run(async () => {const result = await rotateChannelToken(connection.id); setCredential({id: connection.id, name: connection.name, token: result.token}); setCopied(null); setFeedback("Novo token gerado. Atualize o sistema de origem; o anterior deixou de funcionar.");})}>Gerar novo token</Button> : null}</div> : null}
    </Card>)}</div>
    {selectedConnection && canManage ? <Card className="mt-4 gap-3 p-4"><h3 className="text-sm font-semibold">Recebimentos · {selectedConnection.name}</h3><p className="text-xs text-muted-foreground">Este histórico mostra envios reais aceitos pelo endpoint. Mensagens usadas na prévia não aparecem aqui.</p>{!events.length ? <p className="text-sm text-muted-foreground">Ainda não há eventos neste histórico. Após ativar o canal, envie uma mensagem pelo sistema de origem.</p> : null}{events.map(event => <div key={event.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-xs"><div className="min-w-0"><strong className="break-all">{event.externalEventId}</strong><p className="mt-1 text-muted-foreground">{stateLabel[event.state]} · {formatDate(event.receivedAt)} · {event.attempts} tentativa(s)</p>{event.errorCode ? <p className="mt-1 text-destructive">{errorLabel[event.errorCode] ?? "Evento com falha de processamento. Revise os campos do canal."} <code>({event.errorCode})</code></p> : null}</div>{event.state === "failed" ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => {await retryChannelEvent(selectedConnection.id, event.id); setEvents(await getChannelEvents(selectedConnection.id));})}><RefreshCw size={13}/>Reprocessar</Button> : null}</div>)}</Card> : null}
  </SectionLayout>;
}
