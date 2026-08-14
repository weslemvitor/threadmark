import type { TicketPriority, TicketStatus } from "@/app/lib/types";
import { priorityLabels, statusLabels } from "@/app/lib/format";
import { Badge } from "@/app/components/ui/badge";
import { cn } from "@/app/lib/utils";

export function StatusPill({ status }: { status: TicketStatus }) {
  const statusClassName: Record<TicketStatus, string> = {
    new: "bg-primary/10 text-primary",
    triage: "bg-primary/10 text-primary",
    in_progress: "bg-blue-50 text-blue-700",
    waiting_customer: "bg-amber-50 text-amber-800",
    blocked: "bg-amber-50 text-amber-800",
    resolved: "bg-emerald-50 text-emerald-700",
    archived: "bg-muted text-muted-foreground",
  };
  const dotClassName: Record<TicketStatus, string> = {
    new: "bg-primary",
    triage: "bg-primary",
    in_progress: "bg-blue-500",
    waiting_customer: "bg-amber-500",
    blocked: "bg-amber-500",
    resolved: "bg-emerald-500",
    archived: "bg-muted-foreground",
  };

  return (
    <Badge className={cn("gap-1.5 border-0", statusClassName[status])}>
      <span
        aria-hidden="true"
        className={cn("size-1.5 rounded-full", dotClassName[status])}
      />
      {statusLabels[status]}
    </Badge>
  );
}

export function PriorityPill({ priority }: { priority: TicketPriority }) {
  const priorityClassName: Record<TicketPriority, string> = {
    low: "bg-muted text-muted-foreground",
    normal: "bg-muted text-muted-foreground",
    high: "bg-amber-50 text-amber-800",
    urgent: "bg-rose-50 text-rose-700",
  };

  return (
    <Badge className={cn("border-0", priorityClassName[priority])}>
      {priorityLabels[priority]}
    </Badge>
  );
}
