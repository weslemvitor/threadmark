import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";

import type {
  LegacyLocalToolCandidateDto,
  LegacyLocalToolImportResultDto,
  LegacyLocalToolSourceKey,
  LocalToolDto,
  LocalToolWriteInput,
} from "../../shared/contracts.js";
import {
  LocalToolService,
  LocalToolSettingsError,
} from "./local-tool-service.js";

export interface LegacyLocalToolSources {
  codeRoots: string[];
  vaultDirectory: string | null;
}

interface CandidateSpec {
  sourceKey: LegacyLocalToolSourceKey;
  type: "codebase" | "knowledge";
  rawPath: string;
}

interface ResolvedCandidate extends LegacyLocalToolCandidateDto {
  sourceReference: string;
}

/**
 * Discovers only the two historical Threadmark environment settings.
 * Discovery never writes to SQLite and never scans Codex skills or MCP config.
 */
export class LegacyLocalToolImportService {
  constructor(
    private readonly tools: LocalToolService,
    private readonly sources: LegacyLocalToolSources,
  ) {}

  async listCandidates(): Promise<LegacyLocalToolCandidateDto[]> {
    return (await this.resolvedCandidates()).map(publicCandidate);
  }

  async importCandidates(
    candidateIds: string[],
    actor: string,
  ): Promise<LegacyLocalToolImportResultDto> {
    const selectedIds = [...new Set(candidateIds.map((id) => id.trim()).filter(Boolean))];
    if (selectedIds.length === 0) {
      throw new LocalToolSettingsError("Selecione ao menos uma ferramenta antiga para importar.");
    }

    const candidates = await this.resolvedCandidates();
    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const selected = selectedIds.map((id) => {
      const candidate = byId.get(id);
      if (!candidate) {
        throw new LocalToolSettingsError(
          "Uma ferramenta antiga selecionada não está mais disponível. Atualize a lista.",
          "conflict",
        );
      }
      if (candidate.status === "unavailable") {
        throw new LocalToolSettingsError(candidate.statusMessage, "conflict");
      }
      return candidate;
    });

    const importedTools: LocalToolDto[] = [];
    let importedCount = 0;
    let alreadyImportedCount = 0;

    for (const candidate of selected) {
      if (candidate.status === "already_imported") {
        alreadyImportedCount += 1;
        continue;
      }
      const stored = await this.tools.importLegacy(
        toolInput(candidate),
        actor,
        candidate.sourceReference,
      );
      importedTools.push(stored.tool);
      if (stored.created) importedCount += 1;
      else alreadyImportedCount += 1;
    }

    return {
      items: await this.listCandidates(),
      importedTools,
      importedCount,
      alreadyImportedCount,
    };
  }

  private async resolvedCandidates(): Promise<ResolvedCandidate[]> {
    const candidates: ResolvedCandidate[] = [];
    for (const spec of uniqueSpecs(this.sources)) {
      candidates.push(await this.resolveCandidate(spec));
    }
    return candidates;
  }

  private async resolveCandidate(spec: CandidateSpec): Promise<ResolvedCandidate> {
    const rawPath = spec.rawPath.trim();
    const fallbackPath = rawPath && path.isAbsolute(rawPath)
      ? path.normalize(rawPath)
      : rawPath;
    let rootPath = fallbackPath;
    let validationError: string | null = null;

    try {
      if (!rawPath || !path.isAbsolute(rawPath)) {
        throw new Error("O caminho legado não é absoluto.");
      }
      rootPath = await realpath(rawPath);
      const info = await stat(rootPath);
      if (!info.isDirectory()) throw new Error("O caminho legado não é uma pasta.");
      await access(rootPath, fsConstants.R_OK);
    } catch (error) {
      validationError = readablePathError(error);
    }

    const sourceReference = legacySourceReference(spec.sourceKey, rootPath || rawPath);
    const existing = validationError
      ? null
      : await this.findExisting(spec.type, sourceReference, rootPath);
    const name = suggestedName(spec.type, rootPath || rawPath);
    const description = spec.type === "codebase"
      ? "Pasta de código encontrada na configuração antiga. Revise antes de autorizar."
      : "Base local encontrada na configuração antiga. Revise antes de autorizar.";

    if (validationError) {
      return {
        id: candidateId(sourceReference),
        sourceKey: spec.sourceKey,
        type: spec.type,
        name,
        description,
        rootPath,
        status: "unavailable",
        statusMessage: validationError,
        existingToolId: null,
        sourceReference,
      };
    }

    return {
      id: candidateId(sourceReference),
      sourceKey: spec.sourceKey,
      type: spec.type,
      name,
      description,
      rootPath,
      status: existing ? "already_imported" : "ready",
      statusMessage: existing
        ? "Esta pasta já está autorizada como ferramenta local."
        : "Caminho validado. A importação depende da sua confirmação.",
      existingToolId: existing?.id ?? null,
      sourceReference,
    };
  }

  private async findExisting(
    type: "codebase" | "knowledge",
    sourceReference: string,
    rootPath: string,
  ): Promise<LocalToolDto | null> {
    const imported = this.tools.findByLegacySourceRef(sourceReference);
    if (imported) return imported;

    for (const tool of this.tools.list()) {
      if (tool.type !== type) continue;
      const configuredRoot = (tool.config as { rootPath?: unknown }).rootPath;
      if (typeof configuredRoot !== "string") continue;
      const comparable = await realpath(configuredRoot).catch(() => path.resolve(configuredRoot));
      if (comparable === rootPath) return tool;
    }
    return null;
  }
}

function uniqueSpecs(sources: LegacyLocalToolSources): CandidateSpec[] {
  const specs: CandidateSpec[] = sources.codeRoots.map((rawPath) => ({
    sourceKey: "SUPPORT_CODE_ROOTS",
    type: "codebase",
    rawPath,
  }));
  if (sources.vaultDirectory) {
    specs.push({
      sourceKey: "SUPPORT_VAULT_DIR",
      type: "knowledge",
      rawPath: sources.vaultDirectory,
    });
  }
  const seen = new Set<string>();
  return specs.filter((spec) => {
    const key = `${spec.sourceKey}\u0000${path.normalize(spec.rawPath.trim())}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function toolInput(candidate: ResolvedCandidate): LocalToolWriteInput {
  return {
    type: candidate.type,
    name: candidate.name,
    description: candidate.description,
    enabled: true,
    deepEnabled: true,
    allowedOperations: ["list_files", "search_files", "read_files"],
    config: { rootPath: candidate.rootPath },
  } as LocalToolWriteInput;
}

function publicCandidate(candidate: ResolvedCandidate): LegacyLocalToolCandidateDto {
  return {
    id: candidate.id,
    sourceKey: candidate.sourceKey,
    type: candidate.type,
    name: candidate.name,
    description: candidate.description,
    rootPath: candidate.rootPath,
    status: candidate.status,
    statusMessage: candidate.statusMessage,
    existingToolId: candidate.existingToolId,
  };
}

function legacySourceReference(sourceKey: LegacyLocalToolSourceKey, rootPath: string): string {
  return `legacy-env:${sourceKey}:${digest(rootPath)}`;
}

function candidateId(sourceReference: string): string {
  return `legacy-${digest(sourceReference).slice(0, 24)}`;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function suggestedName(type: "codebase" | "knowledge", rootPath: string): string {
  const leaf = path.basename(rootPath) || "Pasta local";
  return type === "codebase" ? `Codebase · ${leaf}` : `Conhecimento · ${leaf}`;
}

function readablePathError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return "O caminho legado não existe ou não está mais disponível.";
  if (code === "EACCES") return "O caminho legado não possui permissão de leitura.";
  if (error instanceof Error && /não é (absoluto|uma pasta)/.test(error.message)) {
    return error.message;
  }
  return "Não foi possível validar o caminho legado em modo somente leitura.";
}
