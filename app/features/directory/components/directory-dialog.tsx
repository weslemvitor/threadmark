"use client";

import { Button } from "@/app/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/app/components/ui/dialog";
import { cn } from "@/app/lib/utils";

import { X, type LucideIcon } from "lucide-react";
import { type ReactNode } from "react";

export const directoryInputClass = "mt-1.5 min-w-0";

export const directoryLabelClass =
  "block min-w-0 text-xs font-medium text-foreground";

type DirectoryDialogProps = {
  children: ReactNode;
  description: string;
  eyebrow: string;
  icon: LucideIcon;
  onClose: () => void;
  open?: boolean;
  saving?: boolean;
  title: string;
  widthClassName?: string;
};

export function DirectoryDialog({
  children,
  description,
  eyebrow,
  icon: Icon,
  onClose,
  open = true,
  saving = false,
  title,
  widthClassName = "sm:max-w-4xl",
}: DirectoryDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !saving) onClose();
      }}
    >
      <DialogContent
        aria-busy={saving}
        className={cn(
          "max-h-[calc(100dvh-1.5rem)] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-h-[calc(100dvh-2.5rem)]",
          widthClassName,
        )}
        showCloseButton={false}
      >
        <DialogHeader className="relative grid grid-cols-[auto_minmax(0,1fr)_auto] gap-3 border-b border-border px-4 py-4 text-left sm:px-6 sm:py-5">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-accent text-primary">
            <Icon size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <span className="text-xs font-bold uppercase tracking-[0.08em] text-primary">
              {eyebrow}
            </span>
            <DialogTitle className="mt-1 text-lg font-semibold tracking-tight">
              {title}
            </DialogTitle>
            <DialogDescription className="mt-1 text-sm leading-5">
              {description}
            </DialogDescription>
          </div>
          <Button
            aria-label="Fechar"
            disabled={saving}
            onClick={onClose}
            size="icon"
            type="button"
            variant="ghost"
          >
            <X size={18} />
          </Button>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </DialogContent>
    </Dialog>
  );
}

export function DirectoryFieldHint({ children }: { children: ReactNode }) {
  return <span className="mt-1.5 block text-xs font-normal leading-5 text-muted-foreground">{children}</span>;
}
