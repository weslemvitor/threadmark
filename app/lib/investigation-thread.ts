export type InvestigationTurnState =
  | "queued"
  | "running"
  | "completed"
  | "cancelled"
  | "failed";

export type InvestigationThreadStatus = "active" | "concluded";

export type InvestigationThreadPresentation = {
  state: InvestigationTurnState | null;
  active: boolean;
  failed: boolean;
  cancelled: boolean;
  label: string;
};

export function isInvestigationTurnActive(
  state: InvestigationTurnState | null | undefined,
): boolean {
  return state === "queued" || state === "running";
}

export function getInvestigationTurnLabel(
  state: InvestigationTurnState | null | undefined,
): string {
  switch (state) {
    case "queued":
      return "Na fila";
    case "running":
      return "Codex investigando";
    case "completed":
      return "Investigação concluída";
    case "cancelled":
      return "Investigação interrompida";
    case "failed":
      return "Falha na investigação";
    default:
      return "Pronto para investigar";
  }
}

export function getInvestigationThreadPresentation(
  activeTurnState: InvestigationTurnState | null | undefined,
  latestTurnState: InvestigationTurnState | null | undefined,
  threadStatus: InvestigationThreadStatus | null | undefined,
): InvestigationThreadPresentation {
  const state = activeTurnState ?? latestTurnState ?? null;
  const active = isInvestigationTurnActive(state);
  const failed = state === "failed";
  const cancelled = state === "cancelled";
  const label = failed
    ? getInvestigationTurnLabel("failed")
    : cancelled
      ? getInvestigationTurnLabel("cancelled")
    : threadStatus === "concluded" && !active
      ? "Investigação concluída"
      : getInvestigationTurnLabel(state);

  return { state, active, failed, cancelled, label };
}
