import { Menu, RefreshCw } from "lucide-react";
import type { RuntimeState } from "@/app/lib/types";
import { Button } from "@/app/components/ui/button";
import { NotificationPreview } from "@/app/features/notifications";
import { cn } from "@/app/lib/utils";

type PageHeaderProps = {
  title: string;
  subtitle: string;
  runtime: RuntimeState | null;
  refreshing: boolean;
  onRefresh: () => void;
  onOpenMenu: () => void;
  unreadNotifications: number;
  onOpenNotifications: () => void;
  onOpenNotificationTarget: (targetUrl: string) => void;
  onUnreadNotificationsChange: (count: number) => void;
};

export function PageHeader({
  title,
  subtitle,
  runtime,
  refreshing,
  onRefresh,
  onOpenMenu,
  unreadNotifications,
  onOpenNotifications,
  onOpenNotificationTarget,
  onUnreadNotificationsChange,
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
        <NotificationPreview
          onOpenAll={onOpenNotifications}
          onOpenTarget={onOpenNotificationTarget}
          onUnreadChange={onUnreadNotificationsChange}
          unread={unreadNotifications}
        />
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
