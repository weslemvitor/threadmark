import { Button } from "@/app/components/ui/button";
import { AlertTriangle, Inbox, LoaderCircle, RotateCcw } from "lucide-react";

export function LoadingState({ label = "Carregando dados do suporte…" }: { label?: string }) {
  return (
    <div className="grid min-h-48 place-items-center content-center gap-3 px-6 text-center" role="status">
      <LoaderCircle className="animate-spin text-primary" size={24} />
      <p className="text-sm text-muted-foreground">{label}</p>
    </div>
  );
}

export function EmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="grid min-h-48 place-items-center content-center gap-2 px-6 text-center">
      <span className="mb-1 grid size-11 place-items-center rounded-xl bg-muted text-muted-foreground">
        <Inbox size={24} />
      </span>
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">{description}</p>
    </div>
  );
}

export function ApiErrorBanner({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="mx-4 mt-4 flex items-start gap-3 rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-destructive" role="alert">
      <AlertTriangle className="mt-0.5 shrink-0" size={19} />
      <div className="min-w-0 flex-1">
        <strong className="block text-xs text-foreground">O painel está sem conexão com o serviço local</strong>
        <span className="mt-1 block break-words text-xs text-muted-foreground">{message}</span>
      </div>
      <Button className="shrink-0" onClick={onRetry} size="sm" type="button" variant="outline">
        <RotateCcw size={15} />
        Tentar novamente
      </Button>
    </div>
  );
}
