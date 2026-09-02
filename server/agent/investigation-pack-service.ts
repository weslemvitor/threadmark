import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  LOCAL_TOOL_OPERATIONS,
  LOCAL_TOOL_TYPES,
  type InvestigationPackDto,
  type InvestigationPackManifest,
  type InvestigationPackOnboardingInput,
  type InvestigationPackReadinessDto,
  type InvestigationPackUpdateInput,
  type LocalToolDto,
  type LocalToolOperation,
  type LocalToolTestResult,
  type LocalToolType,
} from "../../shared/contracts.js";
import type { SupportDatabase } from "../db/index.js";
import type { LocalToolService } from "../tools/local-tool-service.js";

export interface InvestigationPackToolTester {
  test(toolId: string, signal?: AbortSignal): Promise<LocalToolTestResult>;
}

export interface InvestigationPackModelTester {
  testConnection(connectionId: string): Promise<{
    ok: true;
    message: string;
    models: string[];
  }>;
}

export type InvestigationPackErrorKind =
  | "invalid"
  | "not_found"
  | "conflict"
  | "unavailable";

export class InvestigationPackError extends Error {
  constructor(
    message: string,
    readonly kind: InvestigationPackErrorKind = "invalid",
  ) {
    super(message);
    this.name = "InvestigationPackError";
  }
}

interface InvestigationPackRow {
  id: string;
  name: string;
  status: "draft" | "active" | "archived";
  version: number;
  manifest_json: string;
  readiness_json: string;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
  activated_at: string | null;
}

const text = (max: number) => z.string().trim().min(1).max(max);
const vocabularySchema = z.object({
  term: text(120),
  meaning: text(1_000),
}).strict();

const onboardingSchema = z.object({
  name: text(120),
  domain: text(160),
  purpose: text(2_000),
  goals: z.array(text(500)).min(1).max(20),
  selectedToolIds: z.array(text(200)).min(1).max(50),
  vocabulary: z.array(vocabularySchema).max(100).default([]),
  investigationExamples: z.array(text(500)).max(30).default([]),
  includeCustomerDraft: z.boolean().default(false),
}).strict();

const playbookStepSchema = z.object({
  id: text(120),
  title: text(300),
  toolTypes: z.array(z.enum(LOCAL_TOOL_TYPES)).max(7),
  operations: z.array(z.enum(LOCAL_TOOL_OPERATIONS)).max(10),
  evidenceExpected: text(1_000),
  optional: z.boolean(),
}).strict();

const manifestSchema = z.object({
  domain: text(160),
  purpose: text(2_000),
  goals: z.array(text(500)).min(1).max(20),
  selectedToolIds: z.array(text(200)).max(50),
  vocabulary: z.array(vocabularySchema).max(100),
  sourcePolicy: z.object({
    preferredToolTypes: z.array(z.enum(LOCAL_TOOL_TYPES)).max(7),
    minimumIndependentSources: z.number().int().min(1).max(3),
    preferExactIdentifiers: z.boolean(),
  }).strict(),
  responsePolicy: z.object({
    verdictFirst: z.boolean(),
    includeDecisiveNumbers: z.boolean(),
    separateUnknowns: z.boolean(),
    includeCustomerDraft: z.boolean(),
  }).strict(),
  playbooks: z.array(z.object({
    id: text(120),
    title: text(300),
    triggers: z.array(text(500)).max(30),
    objective: text(1_000),
    hypotheses: z.array(text(1_000)).max(30),
    steps: z.array(playbookStepSchema).max(30),
    stopConditions: z.array(text(1_000)).max(20),
  }).strict()).max(20),
}).strict();

const updateSchema = z.object({
  name: text(120).optional(),
  manifest: manifestSchema.optional(),
}).strict().refine((value) => value.name !== undefined || value.manifest !== undefined, {
  message: "Informe ao menos uma alteração para o pack.",
});

export class InvestigationPackService {
  constructor(
    private readonly database: SupportDatabase,
    private readonly tools: LocalToolService,
    private readonly toolTester?: InvestigationPackToolTester,
    private readonly modelTester?: InvestigationPackModelTester,
  ) {}

  list(): InvestigationPackDto[] {
    return (this.database.prepare(
      `SELECT * FROM investigation_packs
       ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END,
                updated_at DESC, id`,
    ).all() as InvestigationPackRow[]).map(packDto);
  }

  getActive(): InvestigationPackDto | null {
    const row = this.database.prepare(
      "SELECT * FROM investigation_packs WHERE status = 'active' LIMIT 1",
    ).get() as InvestigationPackRow | undefined;
    return row ? packDto(row) : null;
  }

  get(id: string): InvestigationPackDto {
    const row = this.database.prepare(
      "SELECT * FROM investigation_packs WHERE id = ?",
    ).get(id) as InvestigationPackRow | undefined;
    if (!row) throw new InvestigationPackError("Pack de investigação não encontrado.", "not_found");
    return packDto(row);
  }

  createDraft(
    raw: InvestigationPackOnboardingInput,
    actorUserId: string,
  ): InvestigationPackDto {
    const input = onboardingSchema.parse(raw);
    const selectedTools = this.resolveSelectedTools(input.selectedToolIds);
    const manifest = createManifest(input, selectedTools);
    const now = new Date().toISOString();
    const id = randomUUID();
    const readiness = this.readiness(manifest, now, "untested");
    this.database.prepare(
      `INSERT INTO investigation_packs (
         id, name, status, version, manifest_json, readiness_json,
         created_by_user_id, created_at, updated_at, activated_at
       ) VALUES (?, ?, 'draft', 1, ?, ?, ?, ?, ?, NULL)`,
    ).run(
      id,
      input.name,
      JSON.stringify(manifest),
      JSON.stringify(readiness),
      actorUserId,
      now,
      now,
    );
    return this.get(id);
  }

  updateDraft(
    id: string,
    raw: InvestigationPackUpdateInput,
  ): InvestigationPackDto {
    const current = this.get(id);
    if (current.status !== "draft") {
      throw new InvestigationPackError(
        "Crie uma nova versão em rascunho antes de alterar um pack ativo.",
        "conflict",
      );
    }
    const input = updateSchema.parse(raw);
    const manifest = input.manifest
      ? manifestSchema.parse(input.manifest)
      : current.manifest;
    this.resolveSelectedTools(manifest.selectedToolIds);
    const now = new Date().toISOString();
    const readiness = this.readiness(manifest, now, "untested");
    this.database.prepare(
      `UPDATE investigation_packs
       SET name = ?, manifest_json = ?, readiness_json = ?,
           version = version + 1, updated_at = ?
       WHERE id = ?`,
    ).run(
      input.name ?? current.name,
      JSON.stringify(manifest),
      JSON.stringify(readiness),
      now,
      id,
    );
    return this.get(id);
  }

  async probe(id: string, signal?: AbortSignal): Promise<InvestigationPackDto> {
    const current = this.get(id);
    if (current.status === "archived") {
      throw new InvestigationPackError("Um pack arquivado não pode ser validado.", "conflict");
    }
    if (!this.toolTester && current.manifest.selectedToolIds.length > 0) {
      throw new InvestigationPackError(
        "O executor de testes das ferramentas não está disponível.",
        "unavailable",
      );
    }
    for (const toolId of current.manifest.selectedToolIds) {
      signal?.throwIfAborted();
      await this.toolTester?.test(toolId, signal);
    }
    const now = new Date().toISOString();
    const profile = this.deepModelProfile();
    let modelStatus: InvestigationPackReadinessDto["model"]["status"] = "missing";
    if (profile?.connection_id && profile.connection_enabled) {
      if (!this.modelTester) {
        modelStatus = "untested";
      } else {
        try {
          const result = await this.modelTester.testConnection(profile.connection_id);
          modelStatus = result.ok && (
            profile.model === "default" ||
            result.models.length === 0 ||
            (result.models.length === 1 && result.models[0] === "default") ||
            result.models.includes(profile.model)
          )
            ? "ready"
            : "unsupported";
        } catch {
          modelStatus = "failed";
        }
      }
    }
    const readiness = this.readiness(current.manifest, now, modelStatus);
    this.database.prepare(
      `UPDATE investigation_packs
       SET readiness_json = ?, updated_at = ? WHERE id = ?`,
    ).run(JSON.stringify(readiness), now, id);
    return this.get(id);
  }

  activate(id: string): InvestigationPackDto {
    const current = this.get(id);
    const modelStillMatches = current.readiness.model.connectionId ===
        this.deepModelProfile()?.connection_id &&
      current.readiness.model.model === this.deepModelProfile()?.model;
    const readiness = this.readiness(
      current.manifest,
      new Date().toISOString(),
      modelStillMatches ? current.readiness.model.status : "untested",
    );
    if (!readiness.deepInvestigationEnabled) {
      throw new InvestigationPackError(
        `O pack ainda não está pronto: ${readiness.messages.join(" ")}`,
        "conflict",
      );
    }
    const now = new Date().toISOString();
    this.database.transaction(() => {
      this.database.prepare(
        `UPDATE investigation_packs
         SET status = 'archived', updated_at = ? WHERE status = 'active' AND id != ?`,
      ).run(now, id);
      this.database.prepare(
        `UPDATE investigation_packs
         SET status = 'active', readiness_json = ?, activated_at = ?, updated_at = ?
         WHERE id = ?`,
      ).run(JSON.stringify(readiness), now, now, id);
    })();
    return this.get(id);
  }

  private resolveSelectedTools(ids: string[]): LocalToolDto[] {
    const enabled = new Map(this.tools.listEnabledForDeep().map((tool) => [tool.id, tool]));
    const missing = ids.filter((id) => !enabled.has(id));
    if (missing.length) {
      throw new InvestigationPackError(
        `Ferramentas ausentes ou desativadas: ${missing.join(", ")}.`,
        "conflict",
      );
    }
    return ids.map((id) => enabled.get(id)!);
  }

  private readiness(
    manifest: InvestigationPackManifest,
    checkedAt: string,
    modelProbeStatus: InvestigationPackReadinessDto["model"]["status"],
  ): InvestigationPackReadinessDto {
    const toolsById = new Map(this.tools.listEnabledForDeep().map((tool) => [tool.id, tool]));
    const toolChecks = manifest.selectedToolIds.map((toolId) => {
      const tool = toolsById.get(toolId);
      return {
        toolId,
        name: tool?.name ?? toolId,
        status: !tool
          ? "missing" as const
          : tool.lastTestStatus === "success"
            ? "ready" as const
            : tool.lastTestStatus === "failed"
              ? "failed" as const
              : "untested" as const,
      };
    });
    const profile = this.deepModelProfile();
    const modelConfigured = Boolean(
      profile?.connection_id && profile.model.trim() && profile.connection_enabled,
    );
    const modelStatus = modelConfigured ? modelProbeStatus : "missing";
    const modelReady = modelStatus === "ready";
    const model = {
      connectionId: profile?.connection_id ?? null,
      model: profile?.model ?? null,
      status: modelStatus,
    };
    const messages: string[] = [];
    if (!modelConfigured) messages.push("Configure e habilite o modelo de investigação profunda.");
    else if (modelStatus === "untested") messages.push("Teste o modelo de investigação profunda.");
    else if (modelStatus === "unsupported") messages.push("O modelo selecionado não aparece no catálogo retornado pelo provedor.");
    else if (modelStatus === "failed") messages.push("O teste da conexão do modelo falhou.");
    if (toolChecks.some((item) => item.status === "missing")) {
      messages.push("Uma ou mais ferramentas selecionadas não estão disponíveis.");
    }
    if (toolChecks.some((item) => item.status === "failed")) {
      messages.push("Uma ou mais ferramentas falharam no teste de conexão.");
    }
    if (toolChecks.some((item) => item.status === "untested")) {
      messages.push("Execute o teste do pack antes de ativá-lo.");
    }
    const toolsReady = toolChecks.every((item) => item.status === "ready");
    const deepInvestigationEnabled = modelReady && toolsReady;
    const state = !modelConfigured || modelStatus === "unsupported" || modelStatus === "failed"
      ? "needs_model" as const
      : toolChecks.some((item) => item.status === "missing" || item.status === "failed")
        ? "needs_tools" as const
        : !toolsReady || modelStatus !== "ready"
          ? "needs_probe" as const
          : "ready" as const;
    if (deepInvestigationEnabled) messages.push("Pack pronto para investigação profunda.");
    return { state, deepInvestigationEnabled, messages, toolChecks, model, checkedAt };
  }

  private deepModelProfile(): {
    connection_id: string | null;
    model: string;
    connection_enabled: number | null;
  } | undefined {
    return this.database.prepare(
      `SELECT profile.connection_id, profile.model, connection.enabled AS connection_enabled
       FROM ai_task_profiles profile
       LEFT JOIN ai_provider_connections connection ON connection.id = profile.connection_id
       WHERE profile.task_kind = 'deep' AND profile.enabled = 1`,
    ).get() as {
      connection_id: string | null;
      model: string;
      connection_enabled: number | null;
    } | undefined;
  }
}

function createManifest(
  input: z.infer<typeof onboardingSchema>,
  tools: LocalToolDto[],
): InvestigationPackManifest {
  const preferredToolTypes = uniqueToolTypes(tools.map((tool) => tool.type));
  const steps = preferredToolTypes.map((toolType, index) => {
    const matching = tools.filter((tool) => tool.type === toolType);
    const operations = uniqueOperations(matching.flatMap((tool) => tool.allowedOperations));
    return {
      id: `source-${index + 1}-${toolType}`,
      title: stepTitle(toolType),
      toolTypes: [toolType],
      operations,
      evidenceExpected: expectedEvidence(toolType),
      optional: toolType === "codebase" || toolType === "vercel",
    };
  });
  return {
    domain: input.domain,
    purpose: input.purpose,
    goals: input.goals,
    selectedToolIds: tools.map((tool) => tool.id),
    vocabulary: input.vocabulary,
    sourcePolicy: {
      preferredToolTypes,
      minimumIndependentSources: preferredToolTypes.length >= 2 ? 2 : 1,
      preferExactIdentifiers: true,
    },
    responsePolicy: {
      verdictFirst: true,
      includeDecisiveNumbers: true,
      separateUnknowns: true,
      includeCustomerDraft: input.includeCustomerDraft,
    },
    playbooks: [{
      id: "root-cause-investigation",
      title: "Investigação de causa raiz",
      triggers: input.investigationExamples.length
        ? input.investigationExamples
        : input.goals,
      objective:
        "Explicar o que aconteceu, reconciliar o impacto, comprovar a causa e distinguir código, configuração, dados, infraestrutura, provedor ou processo.",
      hypotheses: [
        "Configuração incompatível ou incompleta.",
        "Dado ausente, inconsistente ou fora do escopo esperado.",
        "Regra de código bloqueou ou ignorou o processamento.",
        "Falha de infraestrutura ou de provedor externo.",
        "Interpretação incorreta da métrica ou do estado exibido.",
      ],
      steps,
      stopConditions: [
        "A causa foi comprovada por evidência técnica e explica os números observados.",
        "As fontes relevantes foram esgotadas e a incerteza restante foi declarada.",
        "Existe um bloqueio externo específico que nenhuma ferramenta readonly pode resolver.",
      ],
    }],
  };
}

function uniqueToolTypes(values: LocalToolType[]): LocalToolType[] {
  const priority: LocalToolType[] = [
    "debugger_skill",
    "knowledge",
    "postgres_readonly",
    "clickhouse_readonly",
    "aws_cloudwatch",
    "codebase",
    "vercel",
  ];
  const found = new Set(values);
  return priority.filter((item) => found.has(item));
}

function uniqueOperations(values: LocalToolOperation[]): LocalToolOperation[] {
  return [...new Set(values)];
}

function stepTitle(type: LocalToolType): string {
  return {
    debugger_skill: "Carregar a metodologia privada do workspace",
    knowledge: "Consultar conhecimento e convenções locais",
    postgres_readonly: "Localizar entidades e reconciliar estados no PostgreSQL",
    clickhouse_readonly: "Validar eventos analíticos no ClickHouse",
    aws_cloudwatch: "Correlacionar logs e métricas no intervalo exato",
    codebase: "Confirmar a regra implementada no código",
    vercel: "Correlacionar o comportamento com deployments e runtime",
  }[type];
}

function expectedEvidence(type: LocalToolType): string {
  return {
    debugger_skill: "Método e sequência de fontes aplicáveis ao domínio.",
    knowledge: "Terminologia, entidades e procedimentos internos relevantes.",
    postgres_readonly: "Contagens mutuamente exclusivas, estados e identificadores exatos.",
    clickhouse_readonly: "Eventos e agregações no mesmo nível da métrica investigada.",
    aws_cloudwatch: "Eventos, erros ou métricas no recurso e período do incidente.",
    codebase: "Condição de código que explica o comportamento observado.",
    vercel: "Deployment ou log de runtime correlacionado ao incidente.",
  }[type];
}

function packDto(row: InvestigationPackRow): InvestigationPackDto {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    version: row.version,
    manifest: manifestSchema.parse(JSON.parse(row.manifest_json)),
    readiness: JSON.parse(row.readiness_json) as InvestigationPackReadinessDto,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    activatedAt: row.activated_at,
  };
}
