"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Bell,
  CheckCheck,
  ExternalLink,
  LoaderCircle,
  Sparkles,
} from "lucide-react";

import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/app/components/ui/popover";
import {
  getNotifications,
  markAllNotificationsRead,
  updateNotificationRead,
} from "@/app/lib/api";
import { cn } from "@/app/lib/utils";
import type { NotificationDto } from "@/shared/contracts";

const PREVIEW_LIMIT = 5;

type NotificationPreviewProps = {
  unread: number;
  onOpenAll: () => void;
  onOpenTarget: (targetUrl: string) => void;
  onUnreadChange: (count: number) => void;
};

export function NotificationPreview({
  unread,
  onOpenAll,
  onOpenTarget,
  onUnreadChange,
}: NotificationPreviewProps) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await getNotifications({ limit: PREVIEW_LIMIT });
      setItems(result.items);
      onUnreadChange(result.unread);
      setError(null);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Não foi possível carregar as notificações.",
      );
    } finally {
      setLoading(false);
    }
  }, [onUnreadChange]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load, open]);

  const openNotification = useCallback(async (notification: NotificationDto) => {
    if (!notification.readAt) {
      const result = await updateNotificationRead(notification.id, true);
      onUnreadChange(result.unread);
    }
    setOpen(false);
    if (notification.targetUrl) onOpenTarget(notification.targetUrl);
    else onOpenAll();
  }, [onOpenAll, onOpenTarget, onUnreadChange]);

  const markAll = useCallback(async () => {
    const result = await markAllNotificationsRead();
    const readAt = new Date().toISOString();
    setItems((current) => current.map((item) => ({
      ...item,
      readAt: item.readAt ?? readAt,
    })));
    onUnreadChange(result.unread);
  }, [onUnreadChange]);

  const openAll = useCallback(() => {
    setOpen(false);
    onOpenAll();
  }, [onOpenAll]);

  const notificationLabel = unread > 0
    ? `Abrir prévia de notificações (${unread} não lidas)`
    : "Abrir prévia de notificações";

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button
          aria-label={notificationLabel}
          className="relative"
          size="icon"
          title={notificationLabel}
          type="button"
          variant="outline"
        >
          <Bell size={17} />
          {unread > 0 ? (
            <span className="absolute -right-1 -top-1 grid min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] font-bold leading-4 text-primary-foreground">
              {unread > 99 ? "99+" : unread}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[min(380px,calc(100vw-1rem))] overflow-hidden p-0"
        sideOffset={8}
      >
        <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">Notificações</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {unread > 0 ? `${unread} não ${unread === 1 ? "lida" : "lidas"}` : "Tudo em dia"}
            </p>
          </div>
          <Button
            disabled={unread === 0}
            onClick={() => void markAll()}
            size="sm"
            type="button"
            variant="ghost"
          >
            <CheckCheck data-icon="inline-start" />
            Marcar lidas
          </Button>
        </div>

        <div className="max-h-[420px] overflow-y-auto overscroll-contain">
          {loading ? (
            <div className="flex min-h-40 items-center justify-center gap-2 text-xs text-muted-foreground">
              <LoaderCircle className="animate-spin" size={16} />
              Carregando…
            </div>
          ) : error ? (
            <div className="grid min-h-40 place-items-center gap-3 p-5 text-center">
              <p className="text-xs leading-relaxed text-destructive">{error}</p>
              <Button onClick={() => void load()} size="sm" type="button" variant="outline">
                Tentar novamente
              </Button>
            </div>
          ) : items.length === 0 ? (
            <div className="flex min-h-40 flex-col items-center justify-center p-5 text-center">
              <span className="grid size-9 place-items-center rounded-lg bg-muted text-muted-foreground">
                <Bell size={17} />
              </span>
              <strong className="mt-3 text-sm font-semibold">Nenhuma notificação</strong>
              <p className="mt-1 text-xs text-muted-foreground">
                Os avisos das automações aparecerão aqui.
              </p>
            </div>
          ) : (
            <div className="divide-y">
              {items.map((notification) => (
                <Button
                  className={cn(
                    "h-auto w-full justify-start gap-3 rounded-none px-4 py-3 text-left whitespace-normal hover:bg-muted/60",
                    !notification.readAt && "bg-primary/[0.035]",
                  )}
                  key={notification.id}
                  onClick={() => void openNotification(notification)}
                  type="button"
                  variant="ghost"
                >
                  <span className={cn(
                    "grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground",
                    notification.tone === "success" && "bg-emerald-50 text-emerald-700",
                    notification.tone === "warning" && "bg-amber-50 text-amber-700",
                    notification.tone === "urgent" && "bg-rose-50 text-rose-700",
                    !notification.readAt && notification.tone === "info" && "bg-primary/10 text-primary",
                  )}>
                    {notification.sourceType === "automation"
                      ? <Sparkles size={15} />
                      : <Bell size={15} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-2">
                      <strong className="min-w-0 flex-1 truncate text-xs font-semibold">
                        {notification.title}
                      </strong>
                      {!notification.readAt ? (
                        <span className="size-2 shrink-0 rounded-full bg-primary" aria-label="Não lida" />
                      ) : null}
                    </span>
                    <span className="mt-1 line-clamp-2 break-words text-xs font-normal leading-relaxed text-muted-foreground">
                      {notification.body}
                    </span>
                    <span className="mt-2 flex items-center gap-2 text-[11px] font-normal text-muted-foreground">
                      <Badge variant="outline">{sourceLabel(notification.sourceType)}</Badge>
                      <span>{formatPreviewDate(notification.createdAt)}</span>
                      {notification.targetUrl ? <ExternalLink className="ml-auto text-primary" size={12} /> : null}
                    </span>
                  </span>
                </Button>
              ))}
            </div>
          )}
        </div>

        <div className="border-t p-2">
          <Button className="w-full" onClick={openAll} size="sm" type="button" variant="ghost">
            Ver todas as notificações
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function sourceLabel(source: NotificationDto["sourceType"]): string {
  if (source === "automation") return "Automação";
  if (source === "investigation") return "Investigação";
  return "Threadmark";
}

function formatPreviewDate(value: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
  }).format(new Date(value));
}
