"use client";

import { AlertTriangle, LoaderCircle, Trash2 } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/app/components/ui/alert-dialog";
import type { DocumentationDraft } from "@/app/lib/types";

type DocumentationDeleteDialogProps = {
  deleting: boolean;
  draft: DocumentationDraft | null;
  onConfirm: (draft: DocumentationDraft) => Promise<void>;
  onOpenChange: (open: boolean) => void;
};

export function DocumentationDeleteDialog({
  deleting,
  draft,
  onConfirm,
  onOpenChange,
}: DocumentationDeleteDialogProps) {
  return (
    <AlertDialog
      onOpenChange={(open) => {
        if (!deleting) onOpenChange(open);
      }}
      open={draft !== null}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia className="bg-destructive/10 text-destructive">
            <AlertTriangle />
          </AlertDialogMedia>
          <AlertDialogTitle>Excluir esta documentação?</AlertDialogTitle>
          <AlertDialogDescription className="break-words">
            O rascunho do ticket #{draft?.ticketNumber} e todo o histórico das
            gerações serão apagados definitivamente do SQLite. O ticket, as
            mensagens e os anexos originais continuarão preservados.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>Cancelar</AlertDialogCancel>
          <AlertDialogAction
            disabled={deleting || !draft}
            onClick={(event) => {
              event.preventDefault();
              if (draft) void onConfirm(draft);
            }}
            variant="destructive"
          >
            {deleting ? (
              <LoaderCircle className="animate-spin" size={16} />
            ) : (
              <Trash2 size={16} />
            )}
            {deleting ? "Excluindo…" : "Excluir definitivamente"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
