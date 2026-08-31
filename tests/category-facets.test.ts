import assert from "node:assert/strict";
import test from "node:test";

import {
  categoryCreationFacets,
  isCategoryFacetVisible,
} from "../app/lib/category-facets.js";

test("catálogo oferece apenas facetas operacionais para novas categorias", () => {
  assert.deepEqual(categoryCreationFacets, [
    "reason",
    "product",
    "platform",
    "symptom",
  ]);
});

test("facetas legadas vazias somem sem esconder dados já cadastrados", () => {
  assert.equal(isCategoryFacetVisible("reason", 0), true);
  assert.equal(isCategoryFacetVisible("root_cause", 0), false);
  assert.equal(isCategoryFacetVisible("resolution", 0), false);
  assert.equal(isCategoryFacetVisible("root_cause", 1), true);
  assert.equal(isCategoryFacetVisible("resolution", 1), true);
});
