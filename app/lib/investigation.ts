import type { LatestInvestigationDto } from "../../shared/contracts.js";

export type InvestigationSnapshot = LatestInvestigationDto;

export function isInvestigationActive(
  investigation: Pick<InvestigationSnapshot, "state"> | null | undefined,
): boolean {
  return investigation?.state === "queued" || investigation?.state === "running";
}
