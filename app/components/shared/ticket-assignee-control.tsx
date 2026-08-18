import { ChevronDown, LoaderCircle, UserCheck, UserRound, UserX } from "lucide-react";

import { Button } from "@/app/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
import { cn } from "@/app/lib/utils";
import type { TicketAssignee } from "@/app/lib/types";

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/u)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase("pt-BR") ?? "")
    .join("");
}

export function TicketAssigneeControl({
  assignee,
  assignees,
  currentUserId,
  disabled = false,
  compact = false,
  canManage,
  onChange,
}: {
  assignee: TicketAssignee | null;
  assignees: TicketAssignee[];
  currentUserId: string | null;
  disabled?: boolean;
  compact?: boolean;
  canManage: boolean;
  onChange: (assigneeId: string | null) => Promise<boolean>;
}) {
  const currentUser = assignees.find((user) => user.id === currentUserId) ?? null;
  const canClaim = Boolean(currentUser && assignee?.id !== currentUser.id);
  const label = assignee?.displayName ?? "Não atribuído";

  if (!canManage) {
    return (
      <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <span className="grid size-6 shrink-0 place-items-center rounded-full bg-muted font-semibold text-foreground">
          {assignee ? initials(assignee.displayName) : <UserRound size={13} />}
        </span>
        <span className="truncate">{label}</span>
      </span>
    );
  }

  return (
    <div className={cn("flex min-w-0 items-center gap-1.5", compact && "w-full")}>
      {canClaim && !compact ? (
        <Button
          className="h-8 shrink-0 text-xs"
          disabled={disabled}
          onClick={() => void onChange(currentUser?.id ?? null)}
          size="sm"
          type="button"
          variant="secondary"
        >
          {disabled ? <LoaderCircle className="animate-spin" size={13} /> : <UserCheck size={13} />}
          Assumir
        </Button>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={`Responsável: ${label}. Clique para alterar`}
            className={cn(
              "min-w-0 justify-between text-xs",
              compact ? "h-7 w-full px-2" : "h-8 flex-1",
            )}
            disabled={disabled}
            size="sm"
            type="button"
            variant="outline"
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="grid size-5 shrink-0 place-items-center rounded-full bg-primary/10 text-[9px] font-bold text-primary">
                {assignee ? initials(assignee.displayName) : <UserRound size={11} />}
              </span>
              <span className="truncate">{label}</span>
            </span>
            {disabled ? (
              <LoaderCircle className="shrink-0 animate-spin" size={12} />
            ) : (
              <ChevronDown className="shrink-0 text-muted-foreground" size={12} />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel>Responsável pelo ticket</DropdownMenuLabel>
          {canClaim ? (
            <>
              <DropdownMenuItem
                className="text-xs font-medium"
                onSelect={() => void onChange(currentUser?.id ?? null)}
              >
                <UserCheck size={14} />
                Assumir para mim
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          ) : null}
          <DropdownMenuRadioGroup
            onValueChange={(value) => void onChange(value)}
            value={assignee?.id ?? ""}
          >
            {assignees.map((user) => (
              <DropdownMenuRadioItem
                className="text-xs"
                key={user.id}
                value={user.id}
              >
                <span className="grid size-6 shrink-0 place-items-center rounded-full bg-primary/10 text-[9px] font-bold text-primary">
                  {initials(user.displayName)}
                </span>
                <span className="min-w-0 truncate">{user.displayName}</span>
                {user.id === currentUserId ? (
                  <small className="ml-auto text-[10px] text-muted-foreground">Você</small>
                ) : null}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          {assignees.length ? <DropdownMenuSeparator /> : null}
          <DropdownMenuItem
            className="text-xs text-muted-foreground"
            disabled={!assignee}
            onSelect={() => void onChange(null)}
          >
            <UserX size={14} />
            Deixar sem responsável
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
