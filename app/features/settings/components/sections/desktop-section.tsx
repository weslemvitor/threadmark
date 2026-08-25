"use client";

import { Cloud, HardDrive, Laptop, LoaderCircle, Save, ShieldCheck } from "lucide-react";
import { useMemo, useState, useSyncExternalStore } from "react";

import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { Card } from "@/app/components/ui/card";
import { Input } from "@/app/components/ui/input";
import {
  getThreadmarkDesktopBridge,
  type DesktopWorkspaceProfile,
  type ThreadmarkDesktopBridge,
} from "@/app/lib/desktop";
import {
  Field,
  Notice,
  PermissionNotice,
  SectionLayout,
  inputClass,
} from "../settings-support";

const subscribeToDesktopBridge = () => () => undefined;

export function DesktopSection({
  canManage,
  onFeedback,
}: {
  canManage: boolean;
  onFeedback(tone: "success" | "error", message: string): void;
}) {
  const bridge = useSyncExternalStore<ThreadmarkDesktopBridge | null>(
    subscribeToDesktopBridge,
    getThreadmarkDesktopBridge,
    () => null,
  );
  if (!bridge) {
    return (
      <SectionLayout
        description="Escolha se o aplicativo usa esta máquina ou um servidor da sua equipe."
        icon={Laptop}
        title="Aplicativo desktop"
      >
        <Notice tone="warning" title="Disponível somente no aplicativo">
          Abra esta configuração pelo Threadmark instalado no macOS. O acesso pelo
          navegador continua usando a instalação atual.
        </Notice>
      </SectionLayout>
    );
  }

  return (
    <DesktopSettingsForm
      bridge={bridge}
      canManage={canManage}
      onFeedback={onFeedback}
    />
  );
}

function DesktopSettingsForm({
  bridge: desktopBridge,
  canManage,
  onFeedback,
}: {
  bridge: ThreadmarkDesktopBridge;
  canManage: boolean;
  onFeedback(tone: "success" | "error", message: string): void;
}) {
  const [mode, setMode] = useState<DesktopWorkspaceProfile["mode"]>(
    desktopBridge.profile.mode,
  );
  const [serverUrl, setServerUrl] = useState(
    desktopBridge.profile.mode === "remote"
      ? desktopBridge.profile.serverUrl
      : "",
  );
  const [saving, setSaving] = useState(false);
  const normalizedServerUrl = serverUrl.trim().replace(/\/$/, "");
  const remoteUrlValid = useMemo(() => {
    if (mode !== "remote") return true;
    try {
      const url = new URL(normalizedServerUrl);
      return (
        (url.protocol === "https:" ||
          (url.protocol === "http:" &&
            ["127.0.0.1", "localhost", "::1"].includes(url.hostname))) &&
        !url.username &&
        !url.password &&
        url.pathname === "/" &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  }, [mode, normalizedServerUrl]);

  async function save(): Promise<void> {
    if (!canManage || !remoteUrlValid) return;
    setSaving(true);
    try {
      const profile: DesktopWorkspaceProfile =
        mode === "local"
          ? { mode: "local" }
          : { mode: "remote", serverUrl: normalizedServerUrl };
      await desktopBridge.setWorkspaceProfile(profile);
      onFeedback(
        "success",
        mode === "local"
          ? "O aplicativo continuará usando os dados desta máquina."
          : "Conexão salva. O aplicativo abrirá o servidor remoto.",
      );
    } catch (error) {
      onFeedback(
        "error",
        error instanceof Error ? error.message : "Não foi possível salvar a conexão.",
      );
      setSaving(false);
    }
  }

  return (
    <SectionLayout
      description="Escolha onde o Threadmark executa e armazena os dados deste aplicativo."
      icon={Laptop}
      title="Modo do workspace"
    >
      {!canManage ? <PermissionNotice /> : null}
      <div className="grid gap-4 md:grid-cols-2">
        <ModeCard
          active={mode === "local"}
          description="SQLite, anexos, WhatsApp, automações e IA continuam nesta máquina."
          disabled={!canManage || saving}
          icon={HardDrive}
          label="Nesta máquina"
          onClick={() => setMode("local")}
        />
        <ModeCard
          active={mode === "remote"}
          description="O aplicativo se conecta por HTTPS ao servidor compartilhado da equipe."
          disabled={!canManage || saving}
          icon={Cloud}
          label="Servidor remoto"
          onClick={() => setMode("remote")}
        />
      </div>

      {mode === "local" ? (
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <InfoCard
            label="Diretório de dados"
            value={desktopBridge.dataDirectory || "Diretório padrão do macOS"}
          />
          <InfoCard label="API" value={desktopBridge.apiUrl} />
        </div>
      ) : (
        <div className="mt-5 rounded-xl border border-border bg-muted/20 p-4 sm:p-5">
          <Field
            hint="Use a origem HTTPS configurada no servidor, sem caminhos, parâmetros ou credenciais."
            label="URL do servidor Threadmark"
          >
            <Input
              aria-invalid={Boolean(normalizedServerUrl) && !remoteUrlValid}
              className={inputClass}
              disabled={!canManage || saving}
              onChange={(event) => setServerUrl(event.target.value)}
              placeholder="https://support.suaempresa.com"
              type="url"
              value={serverUrl}
            />
          </Field>
          {!remoteUrlValid && normalizedServerUrl ? (
            <p className="mt-2 text-xs text-destructive">
              Informe uma origem HTTPS válida, sem caminho adicional.
            </p>
          ) : null}
        </div>
      )}

      <div className="mt-5 flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-emerald-900">
        <ShieldCheck className="mt-0.5 shrink-0 text-emerald-600" size={18} />
        <div>
          <strong className="text-sm">Trocar o modo não migra nem apaga dados</strong>
          <p className="mt-1 text-xs leading-5 text-emerald-800">
            O workspace local permanece preservado. No modo remoto, somente a conexão
            do aplicativo muda; banco e anexos continuam no servidor escolhido.
          </p>
        </div>
      </div>

      {canManage ? (
        <div className="mt-6 flex justify-end border-t border-border/70 pt-5">
          <Button
            className="w-full sm:w-auto"
            disabled={saving || !remoteUrlValid || (mode === "remote" && !normalizedServerUrl)}
            onClick={() => void save()}
            type="button"
          >
            {saving ? <LoaderCircle className="animate-spin" size={16} /> : <Save size={16} />}
            Salvar e abrir workspace
          </Button>
        </div>
      ) : null}
    </SectionLayout>
  );
}

function ModeCard({
  active,
  description,
  disabled,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean;
  description: string;
  disabled: boolean;
  icon: typeof Laptop;
  label: string;
  onClick(): void;
}) {
  return (
    <Card className={active ? "border-primary/40 bg-primary/5 ring-primary/30" : "bg-card"}>
      <Button
        aria-pressed={active}
        className="h-auto w-full justify-start gap-3 whitespace-normal p-4 text-left"
        disabled={disabled}
        onClick={onClick}
        type="button"
        variant="ghost"
      >
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
          <Icon size={18} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <strong className="text-sm text-foreground">{label}</strong>
            {active ? <Badge variant="secondary">Em uso</Badge> : null}
          </span>
          <span className="mt-1 block text-xs font-normal leading-5 text-muted-foreground">
            {description}
          </span>
        </span>
      </Button>
    </Card>
  );
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-border bg-muted/30 p-4">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <strong className="mt-1 block break-all text-sm font-medium text-foreground">
        {value}
      </strong>
    </div>
  );
}
