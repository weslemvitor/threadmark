import type { CategoryFacetType } from "./types.js";

export const categoryFacetLabels: Record<CategoryFacetType, string> = {
  reason: "Motivo",
  product: "Produto",
  platform: "Plataforma",
  symptom: "Sintoma",
  root_cause: "Causa raiz",
  resolution: "Resolução",
};

export const categoryCreationFacets: CategoryFacetType[] = [
  "reason",
  "product",
  "platform",
  "symptom",
];

export const categoryDisplayOrder: CategoryFacetType[] = [
  "reason",
  "symptom",
  "product",
  "platform",
  "root_cause",
  "resolution",
];

export function isCategoryFacetVisible(
  facet: CategoryFacetType,
  categoryCount: number,
): boolean {
  return categoryCreationFacets.includes(facet) || categoryCount > 0;
}
