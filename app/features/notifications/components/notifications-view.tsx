"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Bell,
  BellOff,
  Check,
  CheckCheck,
  CircleAlert,
  ExternalLink,
  LoaderCircle,
  Sparkles,
} from "lucide-react";

import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { Card, CardContent } from "@/app/components/ui/card";
import {
  getNotifications,
  markAllNotificationsRead,
  updateNotificationRead,
} from "@/app/lib/api";
import { cn } from "@/app/lib/utils";
import type { NotificationDto } from "@/shared/contracts";

const PAGE_SIZE = 20;

type NotificationsViewProps = {
  onOpenTarget: (targetUrl: string) => void;
  onUnreadChange: (count: number) => void;
};

export function NotificationsView({
  onOpenTarget,
  onUnreadChange,
}: NotificationsViewProps) {
  const [items, setItems] = useState<NotificationDto[]>([]);
  const [total, setTotal] = useState(0);
  const [unread, setUnread] = useState(0);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (offset = 0, append = false) => {
    if (append) setLoadingMore(true);
    else setLoading(true);
    try {
      const result = await getNotifications({ unreadOnly, limit: PAGE_SIZE, offset });
      setItems((current) => append ? [...current, ...result.items] : result.items);
      setTotal(unreadOnly ? result.unread : result.total);
      setUnread(result.unread);
      onUnreadChange(result.unread);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível carregar as notificações.");
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [onUnreadChange, unreadOnly]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const markRead = useCallback(async (notification: NotificationDto, read: boolean) => {
    const result = await updateNotificationRead(notification.id, read);
    setItems((current) => unreadOnly && read
      ? current.filter((item) => item.id !== notification.id)
      : current.map((item) => (
          item.id === notification.id
            ? { ...item, readAt: read ? new Date().toISOString() : null }
            : item
        )));
    if (unreadOnly && read) setTotal((current) => Math.max(0, current - 1));
    setUnread(result.unread);
    onUnreadChange(result.unread);
  }, [onUnreadChange, unreadOnly]);

  const open = useCallback(async (notification: NotificationDto) => {
    if (!notification.readAt) await markRead(notification, true);
    if (notification.targetUrl) onOpenTarget(notification.targetUrl);
  }, [markRead, onOpenTarget]);

  const markAll = useCallback(async () => {
    await markAllNotificationsRead();
    setItems((current) => current.map((item) => ({
      ...item,
      readAt: item.readAt ?? new Date().toISOString(),
    })));
    setUnread(0);
    onUnreadChange(0);
    if (unreadOnly) await load();
  }, [load, onUnreadChange, unreadOnly]);

  return (
    <section className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-5 max-[640px]:p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Central de notificações</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Avisos criados por automações, investigações e pelo próprio Threadmark.
          </p>
        </div>
        <Button
          disabled={unread === 0}
          onClick={() => void markAll()}
          size="sm"
          type="button"
          variant="outline"
        >
          <CheckCheck data-icon="inline-start" />
          Marcar todas como lidas
        </Button>
      </div>

      <div className="flex items-center gap-2 border-b border-border pb-3">
        <Button
          aria-pressed={!unreadOnly}
          onClick={() => setUnreadOnly(false)}
          size="sm"
          type="button"
          variant={!unreadOnly ? "default" : "ghost"}
        >
          Todas
        </Button>
        <Button
          aria-pressed={unreadOnly}
          onClick={() => setUnreadOnly(true)}
          size="sm"
          type="button"
          variant={unreadOnly ? "default" : "ghost"}
        >
          Não lidas
          {unread > 0 ? <Badge variant={unreadOnly ? "secondary" : "outline"}>{unread}</Badge> : null}
        </Button>
      </div>

      {error ? (
        <Card className="border-destructive/30 bg-destructive/5 py-0">
          <CardContent className="flex items-center justify-between gap-3 p-4 text-sm text-destructive">
            <span className="flex items-center gap-2"><CircleAlert size={17} />{error}</span>
            <Button onClick={() => void load()} size="sm" type="button" variant="outline">Tentar novamente</Button>
          </CardContent>
        </Card>
      ) : null}

      {loading ? (
        <div className="flex min-h-52 items-center justify-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="animate-spin" size={18} />
          Carregando notificações…
        </div>
      ) : items.length === 0 ? (
        <Card className="py-0">
          <CardContent className="flex min-h-56 flex-col items-center justify-center p-6 text-center">
            <span className="grid size-11 place-items-center rounded-xl bg-muted text-muted-foreground">
              {unreadOnly ? <BellOff size={21} /> : <Bell size={21} />}
            </span>
            <strong className="mt-3 text-sm font-semibold">
              {unreadOnly ? "Nenhuma notificação não lida" : "Nenhuma notificação ainda"}
            </strong>
            <p className="mt-1 max-w-md text-sm text-muted-foreground">
              As automações podem criar avisos aqui sem depender de permissões ou serviços do navegador.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-2">
          {items.map((notification) => (
            <Card
              className={cn(
                "gap-0 py-0 transition-colors",
                !notification.readAt && "border-primary/25 bg-primary/[0.035]",
              )}
              key={notification.id}
            >
              <CardContent className="flex min-w-0 items-start gap-3 p-4 max-[560px]:p-3">
                <span className={cn(
                  "mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground",
                  notification.tone === "success" && "bg-emerald-50 text-emerald-700",
                  notification.tone === "warning" && "bg-amber-50 text-amber-700",
                  notification.tone === "urgent" && "bg-rose-50 text-rose-700",
                  !notification.readAt && notification.tone === "info" && "bg-primary/10 text-primary",
                )}>
                  {notification.sourceType === "automation" ? <Sparkles size={17} /> : <Bell size={17} />}
                </span>
                <Button
                  className="h-auto min-w-0 flex-1 justify-start whitespace-normal p-0 text-left hover:bg-transparent"
                  onClick={() => void open(notification)}
                  type="button"
                  variant="ghost"
                >
                  <span className="block min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <strong className="break-words text-sm font-semibold text-foreground">{notification.title}</strong>
                      {!notification.readAt ? <span className="size-2 rounded-full bg-primary" aria-label="Não lida" /> : null}
                    </span>
                    <span className="mt-1 block whitespace-pre-wrap break-words text-sm font-normal leading-relaxed text-muted-foreground">
                      {notification.body}
                    </span>
                    <span className="mt-2 flex flex-wrap items-center gap-2 text-xs font-normal text-muted-foreground">
                      <Badge variant="outline">{sourceLabel(notification.sourceType)}</Badge>
                      {formatDate(notification.createdAt)}
                      {notification.targetUrl ? <span className="inline-flex items-center gap-1 text-primary">Abrir contexto <ExternalLink size={12} /></span> : null}
                    </span>
                  </span>
                </Button>
                <Button
                  aria-label={notification.readAt ? "Marcar como não lida" : "Marcar como lida"}
                  className="shrink-0"
                  onClick={() => void markRead(notification, !notification.readAt)}
                  size="icon-sm"
                  title={notification.readAt ? "Marcar como não lida" : "Marcar como lida"}
                  type="button"
                  variant="ghost"
                >
                  {notification.readAt ? <Bell size={15} /> : <Check size={15} />}
                </Button>
              </CardContent>
            </Card>
          ))}
          {items.length < total ? (
            <div className="flex justify-center pt-2">
              <Button disabled={loadingMore} onClick={() => void load(items.length, true)} type="button" variant="outline">
                {loadingMore ? <LoaderCircle className="animate-spin" data-icon="inline-start" /> : null}
                Carregar mais
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

function sourceLabel(source: NotificationDto["sourceType"]): string {
  if (source === "automation") return "Automação";
  if (source === "investigation") return "Investigação";
  return "Threadmark";
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
