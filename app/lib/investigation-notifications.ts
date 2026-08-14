import type { InvestigationJobState } from "../../shared/contracts.js";

export type InvestigationNotificationKind = "automatic" | "deep";
export type BrowserNotificationPermission = "default" | "denied" | "granted";
export type BrowserNotificationState =
  | "unsupported"
  | "disabled"
  | "enabled"
  | "blocked";

export function resolveBrowserNotificationState(input: {
  supported: boolean;
  permission: BrowserNotificationPermission;
  optedIn: boolean;
}): BrowserNotificationState {
  if (!input.supported) return "unsupported";
  if (input.permission === "denied") return "blocked";
  return input.permission === "granted" && input.optedIn ? "enabled" : "disabled";
}

export function isFinishedInvestigationState(
  state: InvestigationJobState | null | undefined,
): state is "completed" | "failed" {
  return state === "completed" || state === "failed";
}

export function shouldNotifyInvestigationTransition(
  previousState: InvestigationJobState | null | undefined,
  currentState: InvestigationJobState,
  options: {
    finishedAt?: string | null;
    monitoringStartedAt?: number | null;
  } = {},
): boolean {
  if (!isFinishedInvestigationState(currentState)) return false;
  if (previousState === "queued" || previousState === "running") return true;
  if (previousState !== undefined) return false;

  const { finishedAt, monitoringStartedAt } = options;
  if (!finishedAt || monitoringStartedAt === null || monitoringStartedAt === undefined) {
    return false;
  }

  const finishedTimestamp = Date.parse(finishedAt);
  return Number.isFinite(finishedTimestamp) && finishedTimestamp > monitoringStartedAt;
}

export function getInvestigationNotificationTitle(
  kind: InvestigationNotificationKind,
  state: "completed" | "failed",
): string {
  const investigation = kind === "deep" ? "Investigação aprofundada" : "Investigação automática";
  return state === "completed"
    ? `${investigation} concluída`
    : `${investigation} falhou`;
}
