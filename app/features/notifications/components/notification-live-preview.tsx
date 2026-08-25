"use client";

import {
  ArrowUpRight,
  Bell,
  CheckCircle2,
  CircleAlert,
  Sparkles,
  X,
} from "lucide-react";

import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/app/components/ui/card";
import { cn } from "@/app/lib/utils";
import type { NotificationDto } from "@/shared/contracts";

type NotificationLivePreviewProps = {
  notification: NotificationDto;
  pendingCount: number;
  onDismiss: () => void;
  onOpen: (notification: NotificationDto) => void;
};

export function NotificationLivePreview({
  notification,
  pendingCount,
  onDismiss,
  onOpen,
}: NotificationLivePreviewProps) {
  return (
    <aside
      aria-atomic="true"
      aria-live="polite"
      className="fixed right-5 top-20 z-[210] w-[min(390px,calc(100vw-1.5rem))] animate-in slide-in-from-right-3 fade-in duration-200 max-[640px]:right-3 max-[640px]:top-16"
    >
      <Card className="gap-3 border border-border/80 py-0 shadow-2xl" size="sm">
        <CardHeader className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 border-b px-4 py-3">
          <span
            className={cn(
              "grid size-9 place-items-center rounded-xl bg-primary/10 text-primary",
              notification.tone === "success" && "bg-emerald-50 text-emerald-700",
              notification.tone === "warning" && "bg-amber-50 text-amber-700",
              notification.tone === "urgent" && "bg-rose-50 text-rose-700",
            )}
          >
            <NotificationIcon notification={notification} />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-primary">
                Nova notificação
              </span>
              {pendingCount > 0 ? (
                <Badge variant="secondary">+{pendingCount}</Badge>
              ) : null}
            </div>
            <CardTitle className="mt-1 truncate text-sm">
              {notification.title}
            </CardTitle>
          </div>
          <Button
            aria-label="Fechar prévia"
            onClick={onDismiss}
            size="icon-sm"
            title="Fechar prévia"
            type="button"
            variant="ghost"
          >
            <X />
          </Button>
        </CardHeader>

        <CardContent className="px-4">
          <CardDescription className="line-clamp-3 break-words text-xs leading-relaxed">
            {notification.body}
          </CardDescription>
        </CardContent>

        <CardFooter className="flex items-center justify-between gap-3 border-t px-4 py-2.5">
          <span className="min-w-0 truncate text-[11px] text-muted-foreground">
            {sourceLabel(notification.sourceType)} · {formatArrivalTime(notification.createdAt)}
          </span>
          <Button
            onClick={() => onOpen(notification)}
            size="sm"
            type="button"
            variant="outline"
          >
            Abrir
            <ArrowUpRight data-icon="inline-end" />
          </Button>
        </CardFooter>
      </Card>
    </aside>
  );
}

function NotificationIcon({ notification }: { notification: NotificationDto }) {
  if (notification.tone === "success") return <CheckCircle2 size={17} />;
  if (notification.tone === "warning" || notification.tone === "urgent") {
    return <CircleAlert size={17} />;
  }
  if (notification.sourceType === "automation") return <Sparkles size={17} />;
  return <Bell size={17} />;
}

function sourceLabel(source: NotificationDto["sourceType"]): string {
  if (source === "automation") return "Automação";
  if (source === "investigation") return "Investigação";
  return "Threadmark";
}

function formatArrivalTime(value: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
