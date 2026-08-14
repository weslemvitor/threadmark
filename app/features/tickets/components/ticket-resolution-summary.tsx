import { CheckCircle2, ShieldCheck } from "lucide-react";

import { formatFullDate } from "@/app/lib/format";
import type { TicketDetail as TicketDetailType } from "@/app/lib/types";

export function TicketResolutionSummary({ ticket }: { ticket: TicketDetailType }) {
  const resolution = ticket.resolution;
  if (!resolution) return null;

  return (
    <section aria-label="Resumo do ticket" className="mx-5 mt-5 overflow-hidden rounded-xl border border-emerald-200 bg-emerald-50/60">
      <header className="flex flex-wrap items-center gap-3 border-b border-emerald-200 px-4 py-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-emerald-100 text-emerald-700" aria-hidden="true">
          <CheckCircle2 size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <small className="block text-xs font-semibold uppercase tracking-wide text-emerald-700">Ticket resolvido</small>
          <strong className="block text-base text-foreground">Resumo do ticket</strong>
        </div>
        <time className="text-xs text-muted-foreground" dateTime={resolution.validatedAt}>
          {formatFullDate(resolution.validatedAt)}
        </time>
      </header>
      <div className="px-4 py-3">
        <strong className="text-sm font-semibold text-foreground">Sobre o atendimento</strong>
        <p className="mt-1 break-words text-sm leading-relaxed text-muted-foreground">{ticket.summary}</p>
      </div>
      <div className="border-t border-emerald-200 bg-background/55 px-4 py-3">
        <strong className="text-sm font-semibold text-foreground">Mensagem de resumo</strong>
        <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">{resolution.summary}</p>
      </div>
      <footer className="flex items-center gap-1.5 border-t border-emerald-200 px-4 py-2.5 text-xs text-emerald-800">
        <ShieldCheck size={13} /> Registrado por {resolution.validatedBy}
      </footer>
    </section>
  );
}
