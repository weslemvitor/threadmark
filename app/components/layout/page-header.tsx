import { Bell, BellRing, Menu, RefreshCw } from "lucide-react";
import type { BrowserNotificationState } from "@/app/lib/browser-notifications";
import type { RuntimeState } from "@/app/lib/types";
import { Button } from "@/app/components/ui/button";
import { cn } from "@/app/lib/utils";

type PageHeaderProps = {
  title: string;
  subtitle: string;
  runtime: RuntimeState | null;
  refreshing: boolean;
  onRefresh: () => void;
  onOpenMenu: () => void;
  notificationState: BrowserNotificationState;
  onToggleNotifications: () => void;
};

export function PageHeader({
  title,
  subtitle,
  runtime,
  refreshing,
  onRefresh,
  onOpenMenu,
  notificationState,
  onToggleNotifications,
}: PageHeaderProps) {
  const online = runtime?.whatsappConnected === true;
  const localInvestigation =
    runtime?.state === "offline" && runtime.pid !== null;
  const presentationMode = runtime?.connectedAccount
    ?.toLocaleLowerCase("pt-BR")
    .includes("apresentação") === true;
  const connectionLabel = presentationMode
    ? online
      ? "Demo · WhatsApp"
      : localInvestigation
        ? "Demo · Codex ativo"
        : "Demo · offline"
    : online
      ? "WhatsApp conectado"
      : localInvestigation
        ? "Codex local ativo"
        : "Captura offline";
  const notificationLabel =
    notificationState === "enabled"
      ? "Desativar notificações da sala de investigação"
      : notificationState === "blocked"
        ? "Notificações bloqueadas no navegador"
        : notificationState === "unsupported"
          ? "Notificações não disponíveis neste navegador"
          : "Ativar notificações da sala de investigação";

  return (
    <header className="flex min-h-[72px] shrink-0 items-center gap-3 border-b border-border bg-card px-5 py-3 max-[760px]:min-h-16 max-[760px]:px-3">
      <Button
        aria-label="Abrir navegação"
        className="hidden shrink-0 max-[760px]:inline-flex"
        onClick={onOpenMenu}
        size="icon"
        type="button"
        variant="outline"
      >
        <Menu size={20} />
      </Button>
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-xl font-semibold tracking-tight text-foreground">{title}</h1>
        <p className="mt-0.5 truncate text-sm text-muted-foreground max-[520px]:hidden">{subtitle}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <div
          className={cn(
            "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold max-[620px]:hidden",
            online
              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
              : localInvestigation
                ? "border-primary/20 bg-primary/5 text-primary"
                : "border-border bg-muted/50 text-muted-foreground",
          )}
        >
          <span className={cn("size-1.5 rounded-full bg-muted-foreground", online && "bg-emerald-500", localInvestigation && !online && "bg-primary")} />
          {connectionLabel}
        </div>
        <Button
          aria-label={notificationLabel}
          className={cn(
            notificationState === "enabled" && "border-primary/30 bg-primary/5 text-primary",
            notificationState === "blocked" && "border-destructive/20 bg-destructive/5 text-destructive",
          )}
          disabled={notificationState === "unsupported"}
          onClick={onToggleNotifications}
          title={notificationLabel}
          size="icon"
          type="button"
          variant="outline"
        >
          {notificationState === "enabled" ? <BellRing size={17} /> : <Bell size={17} />}
        </Button>
        <Button
          aria-label="Atualizar dados"
          onClick={onRefresh}
          size="icon"
          type="button"
          variant="outline"
        >
          <RefreshCw className={refreshing ? "animate-spin" : ""} size={17} />
        </Button>
      </div>
    </header>
  );
}
