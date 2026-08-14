"use client";

import { Checkbox } from "@/app/components/ui/checkbox";
import { Check, CheckCircle2, CircleAlert, DatabaseBackup, HardDrive, LoaderCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { createLocalBackup, getLocalStorageUsage, type BackupResult, type LocalStorageUsage } from "@/app/lib/settings";
import { Button } from "@/app/components/ui/button";
import { SectionLayout, Notice, PermissionNotice, formatDate, formatStorageBytes, errorMessage } from "../settings-support";

export function DataSection({ canManage, onFeedback }: { canManage: boolean; onFeedback(tone: "success" | "error", message: string): void }) {
  const [includeAttachments, setIncludeAttachments] = useState(true);
  const [creating, setCreating] = useState(false);
  const [lastBackup, setLastBackup] = useState<BackupResult["backup"] | null>(null);
  const [storage, setStorage] = useState<LocalStorageUsage | null>(null);
  const [storageLoading, setStorageLoading] = useState(canManage);
  const [storageError, setStorageError] = useState<string | null>(null);

  const refreshStorage = useCallback(async () => {
    if (!canManage) return;
    setStorageLoading(true);
    setStorageError(null);
    try {
      setStorage(await getLocalStorageUsage());
    } catch (cause) {
      setStorageError(errorMessage(cause));
    } finally {
      setStorageLoading(false);
    }
  }, [canManage]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshStorage(), 0);
    return () => window.clearTimeout(timer);
  }, [refreshStorage]);

  async function backup() {
    setCreating(true);
    try {
      const result = await createLocalBackup(includeAttachments);
      setLastBackup(result.backup);
      onFeedback("success", "O backup local foi criado e pode ser movido para um local seguro.");
      await refreshStorage();
    } catch (cause) {
      onFeedback("error", errorMessage(cause));
    } finally {
      setCreating(false);
    }
  }

  return (
    <SectionLayout description="Acompanhe o espaço ocupado pelos dados locais e crie cópias consistentes." icon={DatabaseBackup} title="Dados e backup">
      {!canManage ? <PermissionNotice /> : null}
      {canManage ? (
        <div className="mb-6 rounded-2xl border border-border bg-card p-4 sm:p-5">
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
            <div className="flex min-w-0 gap-3">
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-accent text-primary"><HardDrive size={20} /></span>
              <div className="min-w-0"><h3 className="font-semibold text-foreground">Armazenamento local</h3><p className="mt-1 text-sm leading-6 text-muted-foreground">Espaço ocupado pelo diretório de dados local, sem seguir links simbólicos.</p></div>
            </div>
            <Button className="w-full shrink-0 sm:w-auto" variant="outline" disabled={storageLoading} onClick={() => void refreshStorage()} type="button">{storageLoading ? <LoaderCircle className="animate-spin" size={15} /> : <RefreshCw size={15} />} Atualizar uso</Button>
          </div>

          {storageError ? <div className="mt-4"><Notice tone="error" title="Não foi possível medir o armazenamento"><div className="flex flex-wrap items-center justify-between gap-3"><span>{storageError}</span><Button variant="outline" onClick={() => void refreshStorage()} type="button">Tentar novamente</Button></div></Notice></div> : null}

          {!storage && storageLoading ? <div className="mt-5 flex min-h-28 items-center justify-center rounded-xl bg-muted text-sm text-muted-foreground" role="status"><LoaderCircle className="mr-2 animate-spin text-primary" size={17} /> Calculando o uso do disco…</div> : null}

          {storage ? (
            <div className="mt-5">
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
                <StorageMetric className="col-span-2 lg:col-span-1" emphasized label="Total de dados locais" usage={{ bytes: storage.totalBytes, files: storage.scan.filesCounted }} />
                <StorageMetric label="Backups" usage={storage.components.backups} />
                <StorageMetric label="SQLite + WAL/SHM" usage={storage.components.sqlite} />
                <StorageMetric label="Anexos" usage={storage.components.attachments} />
                <StorageMetric label="Logs" usage={storage.components.logs} />
                <StorageMetric label="Outros dados locais" usage={storage.components.other} />
              </div>
              <div className="mt-4 flex flex-col gap-2 border-t border-border/70 pt-4 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
                <span>Medido em {formatDate(storage.measuredAt, true)} · {new Intl.NumberFormat("pt-BR").format(storage.scan.filesCounted)} arquivo(s)</span>
                <span>“Outros” inclui autenticação do WhatsApp, configurações, sessões e dados auxiliares.</span>
              </div>
              {storage.scan.truncated || storage.scan.unreadableEntries > 0 ? <p className="mt-3 flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800" role="status"><CircleAlert className="mt-0.5 shrink-0" size={14} /> A medição foi parcial porque um limite de segurança foi atingido ou algum arquivo estava indisponível. Nenhum link simbólico foi seguido.</p> : null}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="rounded-2xl border border-border bg-card p-5 sm:p-6">
          <div className="flex gap-3"><span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-blue-50 text-blue-700"><DatabaseBackup size={20} /></span><div><h3 className="font-semibold text-foreground">Criar novo backup</h3><p className="mt-1 text-sm leading-6 text-muted-foreground">A API prepara uma cópia do banco sem interromper a captura.</p></div></div>
          <label className="mt-5 flex items-start gap-3 rounded-xl border border-border bg-muted/50 p-4"><Checkbox checked={includeAttachments} className="mt-0.5" disabled={!canManage || creating} onCheckedChange={(checked) => setIncludeAttachments(checked === true)} /><span><b className="block text-sm text-foreground">Incluir imagens, PDFs e documentos</b><small className="mt-1 block text-xs leading-5 text-muted-foreground">O arquivo será maior, mas preservará todas as evidências já capturadas.</small></span></label>
          {lastBackup ? <div className="mt-4 rounded-xl bg-emerald-50 p-4 text-sm text-emerald-800"><div className="flex items-center gap-2 font-semibold"><CheckCircle2 size={16} /> Backup concluído</div><p className="mt-1 text-xs">ID {lastBackup.id} · {formatDate(lastBackup.createdAt)} · {lastBackup.attachmentsIncluded ? "com anexos" : "somente banco"}</p><div className="mt-3 flex min-w-0 items-center gap-2 rounded-lg bg-card/70 p-2"><code className="min-w-0 flex-1 truncate text-xs text-emerald-800" title={lastBackup.directory}>{lastBackup.directory}</code><Button aria-label="Copiar caminho do backup" className="shrink-0 border-emerald-200" onClick={() => void navigator.clipboard.writeText(lastBackup.directory)} size="sm" type="button" variant="outline">Copiar caminho</Button></div></div> : null}
          {canManage ? <div className="mt-5 flex justify-end"><Button  disabled={creating} onClick={() => void backup()} type="button">{creating ? <LoaderCircle className="animate-spin" size={16} /> : <DatabaseBackup size={16} />} Criar backup agora</Button></div> : null}
        </div>
        <aside className="rounded-2xl border border-border bg-card p-5"><HardDrive className="text-primary" size={20} /><h3 className="mt-3 font-semibold text-foreground">Seus dados continuam locais</h3><ul className="mt-3 space-y-3 text-sm leading-5 text-muted-foreground"><li className="flex gap-2"><Check className="mt-0.5 shrink-0 text-emerald-700" size={15} /> SQLite é a fonte de verdade operacional.</li><li className="flex gap-2"><Check className="mt-0.5 shrink-0 text-emerald-700" size={15} /> Credenciais não fazem parte do backup do banco.</li><li className="flex gap-2"><Check className="mt-0.5 shrink-0 text-emerald-700" size={15} /> Nada é enviado para um servidor Threadmark.</li></ul></aside>
      </div>
    </SectionLayout>
  );
}

function StorageMetric({ label, usage, emphasized = false, className = "" }: { label: string; usage: { bytes: number; files: number }; emphasized?: boolean; className?: string }) {
  return <div className={`min-w-0 rounded-xl border p-3.5 ${emphasized ? "border-primary/20 bg-accent" : "border-border/70 bg-muted"} ${className}`}><span className="block text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">{label}</span><strong className={`mt-2 block truncate text-lg ${emphasized ? "text-primary" : "text-foreground"}`} title={`${usage.bytes} bytes`}>{formatStorageBytes(usage.bytes)}</strong><span className="mt-1 block text-xs text-muted-foreground">{new Intl.NumberFormat("pt-BR").format(usage.files)} arquivo(s)</span></div>;
}
