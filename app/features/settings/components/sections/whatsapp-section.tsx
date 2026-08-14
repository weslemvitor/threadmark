"use client";

import { CheckCircle2, LoaderCircle, LockKeyhole, QrCode, RefreshCw, ShieldCheck, Wifi, WifiOff } from "lucide-react";
import { useState } from "react";
import Image from "next/image";
import { getWhatsappQr, getWhatsappRuntime, renewWhatsappQr, type WhatsappQrState } from "@/app/lib/settings";
import type { RuntimeState } from "@/app/lib/types";
import { Button } from "@/app/components/ui/button";
import { SectionLayout, Notice, PermissionNotice, Metric, formatDate, errorMessage } from "../settings-support";

export function WhatsappSection({
  canManage,
  runtime,
  qr,
  onRuntimeChange,
  onQrChange,
}: {
  canManage: boolean;
  runtime: RuntimeState | null;
  qr: WhatsappQrState | null;
  onRuntimeChange(value: RuntimeState): void;
  onQrChange(value: WhatsappQrState | null): void;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [generatingQr, setGeneratingQr] = useState(false);
  const [qrError, setQrError] = useState<string | null>(null);
  const connected = runtime?.whatsappConnected === true;

  async function refresh() {
    setRefreshing(true);
    setQrError(null);
    try {
      const nextRuntime = await getWhatsappRuntime();
      onRuntimeChange(nextRuntime);
      if (canManage && !nextRuntime.whatsappConnected && nextRuntime.qrAvailable) {
        onQrChange(await getWhatsappQr());
      } else {
        onQrChange(null);
      }
    } catch (cause) {
      setQrError(errorMessage(cause));
    } finally {
      setRefreshing(false);
    }
  }

  async function generateQr() {
    setGeneratingQr(true);
    setQrError(null);
    onQrChange(null);
    try {
      await renewWhatsappQr();
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        const nextRuntime = await getWhatsappRuntime();
        onRuntimeChange(nextRuntime);
        if (nextRuntime.whatsappConnected) {
          onQrChange(null);
          return;
        }
        const nextQr = await getWhatsappQr();
        if (nextQr.available && nextQr.dataUrl) {
          onQrChange(nextQr);
          return;
        }
      }
      throw new Error(
        "O WhatsApp não disponibilizou um novo QR code a tempo. Tente novamente.",
      );
    } catch (cause) {
      setQrError(errorMessage(cause));
    } finally {
      setGeneratingQr(false);
    }
  }

  return (
    <SectionLayout description="Conecte a conta usada apenas para capturar conversas recebidas." icon={QrCode} title="Conexão do WhatsApp">
      {!canManage ? <PermissionNotice /> : null}
      <div className="mb-6 rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
        <div className="flex gap-3">
          <ShieldCheck className="mt-0.5 shrink-0 text-emerald-700" size={19} />
          <div><strong className="text-sm text-emerald-800">Integração estritamente somente leitura</strong><p className="mt-1 text-sm leading-6 text-emerald-800">Esta tela conecta a captura inbound. O Threadmark não possui compositor, envio automático ou ação para responder pelo WhatsApp.</p></div>
        </div>
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="rounded-2xl border border-border bg-card p-5 sm:p-6">
          <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
            <div className="flex items-center gap-3">
              <span className={`grid h-11 w-11 place-items-center rounded-xl ${connected ? "bg-emerald-50 text-emerald-700" : "bg-muted text-muted-foreground"}`}>
                {connected ? <Wifi size={20} /> : <WifiOff size={20} />}
              </span>
              <div><h3 className="font-semibold text-foreground">{connected ? "WhatsApp conectado" : runtime?.state === "waiting_qr" ? "Aguardando leitura do QR code" : "WhatsApp desconectado"}</h3><p className="mt-1 text-xs text-muted-foreground">{runtime?.connectedAccount ?? "Nenhuma conta conectada"}</p></div>
            </div>
            <Button variant="outline" disabled={refreshing} onClick={() => void refresh()} type="button">{refreshing ? <LoaderCircle className="animate-spin" size={15} /> : <RefreshCw size={15} />} Atualizar</Button>
          </div>
          <dl className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric label="Grupos" value={runtime?.groupsSynced ?? 0} />
            <Metric label="Monitorados" value={runtime?.monitoredGroups ?? 0} />
            <Metric label="Mensagens" value={runtime?.messagesStored ?? 0} />
            <Metric label="Última sincronização" value={runtime?.lastSyncAt ? formatDate(runtime.lastSyncAt, true) : "—"} />
          </dl>
          {runtime?.lastError ? <div className="mt-5"><Notice tone="error" title="Erro informado pela captura">{runtime.lastError}</Notice></div> : null}
          {qrError ? <div className="mt-5"><Notice tone="error" title="QR code indisponível">{qrError}</Notice></div> : null}
        </div>

        <div className="flex min-h-[320px] items-center justify-center rounded-2xl border border-border bg-card p-5 text-center">
          {connected ? (
            <div className="max-w-[250px]"><span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-emerald-50 text-emerald-700"><CheckCircle2 size={27} /></span><h3 className="mt-4 font-semibold text-foreground">Conta pronta para captura</h3><p className="mt-2 text-sm leading-6 text-muted-foreground">Novas mensagens serão armazenadas enquanto o serviço local estiver ligado.</p></div>
          ) : !canManage ? (
            <div className="max-w-[250px]"><span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-muted text-muted-foreground"><LockKeyhole size={26} /></span><h3 className="mt-4 font-semibold text-foreground">Conexão protegida</h3><p className="mt-2 text-sm leading-6 text-muted-foreground">Somente proprietários e administradores podem visualizar ou renovar o QR code.</p></div>
          ) : qr?.dataUrl ? (
            <div><Image alt="QR code para conectar o WhatsApp" className="mx-auto h-56 w-56 rounded-xl border border-border/70 bg-card p-2" height={224} priority src={qr.dataUrl} unoptimized width={224} /><h3 className="mt-4 font-semibold text-foreground">Leia com o WhatsApp</h3><p className="mt-1 text-xs text-muted-foreground">Aponte a câmera em Aparelhos conectados.</p></div>
          ) : (
            <div className="max-w-[250px]"><span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-muted text-muted-foreground"><QrCode size={26} /></span><h3 className="mt-4 font-semibold text-foreground">QR code ainda não disponível</h3><p className="mt-2 text-sm leading-6 text-muted-foreground">Gere uma nova sessão para conectar a captura inbound do WhatsApp.</p><Button className="mt-4" variant="outline" disabled={refreshing || generatingQr} onClick={() => void generateQr()} type="button">{generatingQr ? <LoaderCircle className="animate-spin" size={15} /> : <QrCode size={15} />} {generatingQr ? "Gerando QR code..." : "Gerar QR code"}</Button></div>
          )}
        </div>
      </div>
    </SectionLayout>
  );
}
