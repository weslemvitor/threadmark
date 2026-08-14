import investigationTurnSchemaDocument from "./investigation-turn.schema.json" with { type: "json" };
import supportAnalysisSchemaDocument from "./support-analysis.schema.json" with { type: "json" };
import triageAnalysisSchemaDocument from "./triage-analysis.schema.json" with { type: "json" };

import type { JsonSchemaDocument } from "./provider.js";

export const SUPPORT_ANALYSIS_JSON_SCHEMA = withoutDialectDeclaration(
  supportAnalysisSchemaDocument,
);

export const INVESTIGATION_TURN_JSON_SCHEMA = withoutDialectDeclaration(
  investigationTurnSchemaDocument,
);

export const TRIAGE_ANALYSIS_JSON_SCHEMA = withoutDialectDeclaration(
  triageAnalysisSchemaDocument,
);

function withoutDialectDeclaration(value: object): JsonSchemaDocument {
  const schema = { ...value } as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}
