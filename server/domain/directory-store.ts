import { randomUUID } from "node:crypto";

import {
  DIRECTORY_FIELD_TYPES,
  DIRECTORY_SEGMENT_OPERATORS,
  type DirectoryFieldDefinitionDto,
  type DirectoryFieldDefinitionInput,
  type DirectoryFieldType,
  type DirectoryFieldValue,
  type DirectoryGroupDto,
  type DirectoryPersonDto,
  type DirectoryRecordDto,
  type DirectoryRecordInput,
  type DirectoryRecordTypeDto,
  type DirectoryRecordTypeInput,
  type DirectorySegmentDto,
  type DirectorySegmentFilterDto,
  type DirectorySegmentInput,
  type DirectorySegmentOperator,
  type DirectorySnapshotDto,
} from "../../shared/contracts.js";
import type { SupportDatabase } from "../db/index.js";

import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { isHumanParticipantDisplayName } from "./participant-identity.js";

const DEFAULT_ACTOR = "local-operator";
const MAX_NAME_LENGTH = 160;
const MAX_DESCRIPTION_LENGTH = 5_000;
const MAX_FIELD_VALUE_LENGTH = 20_000;
const MAX_OPTIONS = 100;

const DIRECTORY_FIELD_TYPE_SET = new Set<string>(DIRECTORY_FIELD_TYPES);
const DIRECTORY_SEGMENT_OPERATOR_SET = new Set<string>(
  DIRECTORY_SEGMENT_OPERATORS,
);

interface RecordTypeRow {
  id: string;
  name: string;
  plural_name: string;
  slug: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  system: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

interface FieldRow {
  id: string;
  record_type_id: string;
  key: string;
  label: string;
  field_type: DirectoryFieldType;
  required: number;
  options_json: string;
  relation_record_type_id: string | null;
  position: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

interface RecordRow {
  id: string;
  record_type_id: string;
  legacy_client_id: string | null;
  name: string;
  slug: string;
  description: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  ticket_count: number;
  open_ticket_count: number;
  group_activity_at: string | null;
  ticket_activity_at: string | null;
}

interface SegmentRow {
  id: string;
  name: string;
  description: string | null;
  record_type_id: string | null;
  match_mode: "all" | "any";
  filters_json: string;
  created_at: string;
  updated_at: string;
}

interface PersonRow {
  id: string;
  display_name: string;
  phone_e164: string | null;
  external_jid: string;
  is_staff: number;
  last_activity_at: string | null;
  created_at: string;
  updated_at: string;
}

interface IdentityLinkRow {
  phone_jid: string;
  lid_jid: string;
}

interface CanonicalPersonGroup {
  canonicalJid: string;
  representative: PersonRow;
  aliases: PersonRow[];
}

interface CanonicalPeopleResult {
  people: DirectoryPersonDto[];
  canonicalIdByParticipantId: Map<string, string>;
}

interface NormalizedRecordTypeInput {
  name: string;
  pluralName: string;
  slug: string;
  description: string | null;
  icon: string | null;
  color: string | null;
}

interface NormalizedFieldInput {
  recordTypeId: string;
  key: string;
  label: string;
  type: DirectoryFieldType;
  required: boolean;
  options: string[];
  relationRecordTypeId: string | null;
  position: number;
}

interface NormalizedRecordInput {
  typeId: string;
  name: string;
  slug: string;
  description: string | null;
  values: Record<string, DirectoryFieldValue>;
  groupIds: string[];
  personIds: string[];
  relatedRecordIds: string[];
}

interface NormalizedSegmentInput {
  name: string;
  description: string | null;
  recordTypeId: string | null;
  match: "all" | "any";
  filters: DirectorySegmentFilterDto[];
}

function nowUtc(): string {
  return new Date().toISOString();
}

function normalizedText(value: string, field: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized) throw new ValidationError(`${field} é obrigatório`);
  if (normalized.length > maximum) {
    throw new ValidationError(`${field} deve ter no máximo ${maximum} caracteres`);
  }
  return normalized;
}

function normalizedOptionalText(
  value: string | null | undefined,
  field: string,
  maximum: number,
): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maximum) {
    throw new ValidationError(`${field} deve ter no máximo ${maximum} caracteres`);
  }
  return normalized;
}

function normalizedActor(actor?: string): string {
  return actor
    ? normalizedText(actor, "Responsável", 160)
    : DEFAULT_ACTOR;
}

function slugify(value: string): string {
  const slug = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  if (!slug) throw new ValidationError("Slug inválido");
  return slug;
}

function normalizeSlug(value: string | undefined, fallback: string): string {
  const candidate = value?.trim() || fallback;
  const normalized = slugify(candidate);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized)) {
    throw new ValidationError("Slug inválido", { value });
  }
  return normalized;
}

function normalizeFieldKey(value: string | undefined, fallback: string): string {
  const candidate = value?.trim() || fallback;
  const key = slugify(candidate).replaceAll("-", "_");
  if (!/^[a-z][a-z0-9_]*$/.test(key)) {
    throw new ValidationError("Chave do campo inválida", { value });
  }
  return key;
}

function uniqueIds(values: string[] | undefined, field: string): string[] {
  if (!values) return [];
  const normalized = values.map((value) =>
    normalizedText(value, field, 200),
  );
  if (new Set(normalized).size !== normalized.length) {
    throw new ValidationError(`${field} contém itens repetidos`);
  }
  return normalized;
}

function isSqliteConstraint(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("SQLITE_CONSTRAINT")
  );
}

function parsedOptions(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      Array.isArray(parsed) &&
      parsed.every((option) => typeof option === "string")
    ) {
      return parsed;
    }
  } catch {
    // A leitura permanece segura mesmo se um banco tiver sido editado externamente.
  }
  return [];
}

function parsedFieldValue(value: string): DirectoryFieldValue {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      parsed === null ||
      typeof parsed === "string" ||
      typeof parsed === "number" ||
      typeof parsed === "boolean" ||
      (Array.isArray(parsed) &&
        parsed.every((item) => typeof item === "string"))
    ) {
      return parsed;
    }
  } catch {
    // Valor inválido nunca vira SQL nem objeto executável.
  }
  return null;
}

function parsedFilters(value: string): DirectorySegmentFilterDto[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const candidate = item as Record<string, unknown>;
      if (
        typeof candidate.fieldId !== "string" ||
        typeof candidate.operator !== "string" ||
        !DIRECTORY_SEGMENT_OPERATOR_SET.has(candidate.operator)
      ) {
        return [];
      }
      return [
        {
          fieldId: candidate.fieldId,
          operator: candidate.operator as DirectorySegmentOperator,
          ...(candidate.value !== undefined
            ? { value: candidate.value as DirectoryFieldValue }
            : {}),
        },
      ];
    });
  } catch {
    return [];
  }
}

function rowToField(row: FieldRow): DirectoryFieldDefinitionDto {
  return {
    id: row.id,
    recordTypeId: row.record_type_id,
    key: row.key,
    label: row.label,
    type: row.field_type,
    required: Boolean(row.required),
    options: parsedOptions(row.options_json),
    relationRecordTypeId: row.relation_record_type_id,
    position: row.position,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function latestTimestamp(...values: Array<string | null>): string | null {
  const available = values.filter((value): value is string => Boolean(value));
  return available.length ? available.sort().at(-1)! : null;
}

function phoneFromJid(jid: string): string | null {
  if (!jid.endsWith("@s.whatsapp.net")) return null;
  const digits = jid.slice(0, -"@s.whatsapp.net".length);
  return /^\d{7,15}$/.test(digits) ? `+${digits}` : null;
}

function normalizedPhone(value: string | null): string | null {
  const candidate = value?.trim() ?? "";
  return /^\+\d{7,15}$/.test(candidate) ? candidate : null;
}

function isHumanDisplayName(name: string, aliases: readonly PersonRow[]): boolean {
  return isHumanParticipantDisplayName(
    name,
    aliases.flatMap((alias) => [alias.external_jid, alias.phone_e164]),
  );
}

function canonicalPersonGroups(
  rows: readonly PersonRow[],
  links: readonly IdentityLinkRow[],
): {
  groups: CanonicalPersonGroup[];
  canonicalIdByParticipantId: Map<string, string>;
} {
  const canonicalJidByAlias = new Map<string, string>();
  for (const link of links) {
    canonicalJidByAlias.set(link.phone_jid, link.phone_jid);
    canonicalJidByAlias.set(link.lid_jid, link.phone_jid);
  }

  const aliasesByCanonicalJid = new Map<string, PersonRow[]>();
  for (const row of rows) {
    const canonicalJid = canonicalJidByAlias.get(row.external_jid) ?? row.external_jid;
    aliasesByCanonicalJid.set(canonicalJid, [
      ...(aliasesByCanonicalJid.get(canonicalJid) ?? []),
      row,
    ]);
  }

  const canonicalIdByParticipantId = new Map<string, string>();
  const groups = [...aliasesByCanonicalJid].map(([canonicalJid, aliases]) => {
    const orderedAliases = aliases.toSorted((left, right) => {
      const leftIsCanonical = left.external_jid === canonicalJid ? 0 : 1;
      const rightIsCanonical = right.external_jid === canonicalJid ? 0 : 1;
      if (leftIsCanonical !== rightIsCanonical) {
        return leftIsCanonical - rightIsCanonical;
      }
      const leftIsPhone = left.external_jid.endsWith("@s.whatsapp.net") ? 0 : 1;
      const rightIsPhone = right.external_jid.endsWith("@s.whatsapp.net") ? 0 : 1;
      if (leftIsPhone !== rightIsPhone) return leftIsPhone - rightIsPhone;
      return left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id);
    });
    const representative = orderedAliases[0]!;
    for (const alias of aliases) {
      canonicalIdByParticipantId.set(alias.id, representative.id);
    }
    return { canonicalJid, representative, aliases };
  });

  return { groups, canonicalIdByParticipantId };
}

function isEmptyValue(value: DirectoryFieldValue | undefined): boolean {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}

function comparableText(value: DirectoryFieldValue | undefined): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.join(" ").toLocaleLowerCase("pt-BR");
  return String(value).toLocaleLowerCase("pt-BR");
}

function equalValues(
  current: DirectoryFieldValue | undefined,
  expected: DirectoryFieldValue | undefined,
): boolean {
  if (Array.isArray(current) || Array.isArray(expected)) {
    if (!Array.isArray(current) || !Array.isArray(expected)) return false;
    return (
      current.length === expected.length &&
      current.every((value, index) => value === expected[index])
    );
  }
  return current === expected;
}

function matchesFilter(
  value: DirectoryFieldValue | undefined,
  filter: DirectorySegmentFilterDto,
): boolean {
  switch (filter.operator) {
    case "is_empty":
      return isEmptyValue(value);
    case "is_not_empty":
      return !isEmptyValue(value);
    case "equals":
      return equalValues(value, filter.value);
    case "not_equals":
      return !equalValues(value, filter.value);
    case "contains": {
      if (Array.isArray(value)) {
        const expected = Array.isArray(filter.value)
          ? filter.value
          : [String(filter.value ?? "")];
        return expected.every((item) => value.includes(item));
      }
      return comparableText(value).includes(comparableText(filter.value));
    }
    case "not_contains":
      return !matchesFilter(value, { ...filter, operator: "contains" });
    case "greater_than":
      if (typeof value === "number" && typeof filter.value === "number") {
        return value > filter.value;
      }
      return comparableText(value) > comparableText(filter.value);
    case "less_than":
      if (typeof value === "number" && typeof filter.value === "number") {
        return value < filter.value;
      }
      return comparableText(value) < comparableText(filter.value);
  }
}

export class DirectoryStore {
  constructor(readonly database: SupportDatabase) {}

  getSnapshot(): DirectorySnapshotDto {
    const fields = this.readFields();
    const valuesByRecord = this.readValuesByRecord();
    const groupIdsByRecord = this.readLinkMap(
      "directory_group_links",
      "record_id",
      "group_id",
    );
    const storedPersonIdsByRecord = this.readLinkMap(
      "directory_person_links",
      "record_id",
      "participant_id",
    );
    const canonicalPeople = this.readPeople(storedPersonIdsByRecord);
    const personIdsByRecord = new Map(
      [...storedPersonIdsByRecord].map(([recordId, participantIds]) => [
        recordId,
        [
          ...new Set(
            participantIds.map(
              (participantId) =>
                canonicalPeople.canonicalIdByParticipantId.get(participantId) ??
                participantId,
            ),
          ),
        ].sort(),
      ]),
    );
    const relatedRecordIdsByRecord = this.readRelatedRecordIds();
    const records = this.readRecords(
      valuesByRecord,
      groupIdsByRecord,
      personIdsByRecord,
      relatedRecordIdsByRecord,
    );
    const activeRecords = records.filter((record) => !record.archivedAt);
    const recordCountByType = new Map<string, number>();
    for (const record of activeRecords) {
      recordCountByType.set(
        record.typeId,
        (recordCountByType.get(record.typeId) ?? 0) + 1,
      );
    }
    const recordTypes = this.readRecordTypes(recordCountByType);
    const groups = this.readGroups();
    const people = canonicalPeople.people;
    const segments = this.readSegments(activeRecords, fields);

    return {
      groups,
      people,
      recordTypes,
      fields,
      records,
      segments,
      totals: {
        groups: groups.length,
        people: people.length,
        records: activeRecords.length,
        segments: segments.length,
      },
    };
  }

  createRecordType(
    input: DirectoryRecordTypeInput,
    actor?: string,
  ): DirectoryRecordTypeDto {
    const normalized = this.normalizeRecordTypeInput(input);
    const responsible = normalizedActor(actor);
    const id = randomUUID();
    const timestamp = nowUtc();

    try {
      this.database
        .prepare(
          `INSERT INTO directory_record_types (
             id, name, plural_name, slug, description, icon, color, system,
             archived_at, archived_by, created_by, updated_by, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?, ?, ?)`,
        )
        .run(
          id,
          normalized.name,
          normalized.pluralName,
          normalized.slug,
          normalized.description,
          normalized.icon,
          normalized.color,
          responsible,
          responsible,
          timestamp,
          timestamp,
        );
    } catch (error) {
      this.rethrowConstraint(error, "Já existe um tipo de registro com este slug");
    }
    return this.readRecordType(id);
  }

  updateRecordType(
    id: string,
    input: DirectoryRecordTypeInput,
    actor?: string,
  ): DirectoryRecordTypeDto {
    const existing = this.recordTypeRow(id);
    if (existing.archived_at) {
      throw new ConflictError("O tipo de registro está arquivado", { id });
    }
    const normalized = this.normalizeRecordTypeInput(input, existing.slug);
    if (existing.system && normalized.slug !== existing.slug) {
      throw new ConflictError("O slug de um tipo nativo não pode ser alterado", {
        id,
      });
    }
    try {
      this.database
        .prepare(
          `UPDATE directory_record_types
           SET name = ?, plural_name = ?, slug = ?, description = ?, icon = ?,
               color = ?, updated_by = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          normalized.name,
          normalized.pluralName,
          normalized.slug,
          normalized.description,
          normalized.icon,
          normalized.color,
          normalizedActor(actor),
          nowUtc(),
          id,
        );
    } catch (error) {
      this.rethrowConstraint(error, "Já existe um tipo de registro com este slug");
    }
    return this.readRecordType(id);
  }

  createField(
    input: DirectoryFieldDefinitionInput,
    actor?: string,
  ): DirectoryFieldDefinitionDto {
    const nextPosition = this.nextFieldPosition(input.recordTypeId);
    const normalized = this.normalizeFieldInput(input, nextPosition);
    this.assertActiveRecordType(normalized.recordTypeId);
    this.assertRelationRecordType(normalized);
    if (normalized.required && this.activeRecordCount(normalized.recordTypeId) > 0) {
      throw new ConflictError(
        "Preencha os registros existentes antes de tornar o novo campo obrigatório",
        { recordTypeId: normalized.recordTypeId },
      );
    }
    const id = randomUUID();
    const responsible = normalizedActor(actor);
    const timestamp = nowUtc();
    try {
      this.database
        .prepare(
          `INSERT INTO directory_field_definitions (
             id, record_type_id, key, label, field_type, required, options_json,
             relation_record_type_id, position, archived_at, archived_by,
             created_by, updated_by, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
        )
        .run(
          id,
          normalized.recordTypeId,
          normalized.key,
          normalized.label,
          normalized.type,
          Number(normalized.required),
          JSON.stringify(normalized.options),
          normalized.relationRecordTypeId,
          normalized.position,
          responsible,
          responsible,
          timestamp,
          timestamp,
        );
    } catch (error) {
      this.rethrowConstraint(
        error,
        "Já existe um campo com esta chave para o tipo selecionado",
      );
    }
    return this.readField(id);
  }

  updateField(
    id: string,
    input: DirectoryFieldDefinitionInput,
    actor?: string,
  ): DirectoryFieldDefinitionDto {
    const existing = this.fieldRow(id);
    if (existing.archived_at) {
      throw new ConflictError("O campo está arquivado", { id });
    }
    const normalized = this.normalizeFieldInput(input, existing.position, existing.key);
    if (normalized.recordTypeId !== existing.record_type_id) {
      throw new ConflictError("Um campo não pode ser movido para outro tipo de registro", {
        id,
      });
    }
    this.assertRelationRecordType(normalized);

    const candidate: DirectoryFieldDefinitionDto = {
      ...rowToField(existing),
      key: normalized.key,
      label: normalized.label,
      type: normalized.type,
      required: normalized.required,
      options: normalized.options,
      relationRecordTypeId: normalized.relationRecordTypeId,
      position: normalized.position,
    };
    const values = this.database
      .prepare(
        `SELECT record_id, value_json
         FROM directory_field_values
         WHERE field_id = ?`,
      )
      .all(id) as Array<{ record_id: string; value_json: string }>;
    for (const row of values) {
      const value = parsedFieldValue(row.value_json);
      this.validateFieldValue(candidate, value);
      this.assertRelationTargets(candidate, value);
    }
    if (normalized.required) {
      const missing = this.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM directory_records record
           WHERE record.record_type_id = ?
             AND record.archived_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM directory_field_values value
               WHERE value.record_id = record.id AND value.field_id = ?
                 AND value.value_json NOT IN ('null', '""', '[]')
             )`,
        )
        .get(existing.record_type_id, id) as { count: number };
      if (missing.count > 0) {
        throw new ConflictError(
          "O campo não pode ser obrigatório enquanto houver registros sem valor",
          { id, missing: missing.count },
        );
      }
    }

    try {
      this.database
        .prepare(
          `UPDATE directory_field_definitions
           SET key = ?, label = ?, field_type = ?, required = ?, options_json = ?,
               relation_record_type_id = ?, position = ?, updated_by = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          normalized.key,
          normalized.label,
          normalized.type,
          Number(normalized.required),
          JSON.stringify(normalized.options),
          normalized.relationRecordTypeId,
          normalized.position,
          normalizedActor(actor),
          nowUtc(),
          id,
        );
    } catch (error) {
      this.rethrowConstraint(
        error,
        "Já existe um campo com esta chave para o tipo selecionado",
      );
    }
    return this.readField(id);
  }

  createRecord(
    input: DirectoryRecordInput,
    actor?: string,
  ): DirectoryRecordDto {
    const id = randomUUID();
    const normalized = this.normalizeRecordInput(input);
    const fields = this.validateRecordState(id, normalized);
    const responsible = normalizedActor(actor);
    const timestamp = nowUtc();
    const save = this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO directory_records (
             id, record_type_id, legacy_client_id, legacy_store_id, name, slug,
             description, source, archived_at, archived_by, created_by, updated_by,
             created_at, updated_at
           ) VALUES (?, ?, NULL, NULL, ?, ?, ?, 'manual', NULL, NULL, ?, ?, ?, ?)`,
        )
        .run(
          id,
          normalized.typeId,
          normalized.name,
          normalized.slug,
          normalized.description,
          responsible,
          responsible,
          timestamp,
          timestamp,
        );
      this.replaceRecordValues(id, normalized.values, fields, responsible, timestamp);
      this.replaceGroupLinks(id, normalized.groupIds, responsible, timestamp);
      this.replacePersonLinks(id, normalized.personIds, responsible, timestamp);
      this.replaceRelatedLinks(
        id,
        normalized.relatedRecordIds,
        responsible,
        timestamp,
      );
      this.replaceFieldRelationLinks(id, fields, normalized.values, responsible, timestamp);
    });
    try {
      save();
    } catch (error) {
      this.rethrowConstraint(error, "Já existe um registro com este slug neste tipo");
    }
    return this.readRecord(id);
  }

  updateRecord(
    id: string,
    input: DirectoryRecordInput,
    actor?: string,
  ): DirectoryRecordDto {
    const existing = this.recordRow(id);
    if (existing.archived_at) {
      throw new ConflictError("O registro está arquivado", { id });
    }
    const current = this.readRecord(id);
    const normalized = this.normalizeRecordInput(input, {
      slug: existing.slug,
      values:
        input.typeId === existing.record_type_id ? current.values : {},
      groupIds: current.groupIds,
      personIds: current.personIds,
      relatedRecordIds: current.relatedRecordIds,
    });
    const fields = this.validateRecordState(id, normalized);
    const responsible = normalizedActor(actor);
    const timestamp = nowUtc();
    const save = this.database.transaction(() => {
      this.database
        .prepare(
          `UPDATE directory_records
           SET record_type_id = ?, name = ?, slug = ?, description = ?,
               updated_by = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          normalized.typeId,
          normalized.name,
          normalized.slug,
          normalized.description,
          responsible,
          timestamp,
          id,
        );
      this.replaceRecordValues(id, normalized.values, fields, responsible, timestamp);
      this.replaceGroupLinks(id, normalized.groupIds, responsible, timestamp);
      this.replacePersonLinks(id, normalized.personIds, responsible, timestamp);
      this.replaceRelatedLinks(
        id,
        normalized.relatedRecordIds,
        responsible,
        timestamp,
      );
      this.replaceFieldRelationLinks(id, fields, normalized.values, responsible, timestamp);
    });
    try {
      save();
    } catch (error) {
      this.rethrowConstraint(error, "Já existe um registro com este slug neste tipo");
    }
    return this.readRecord(id);
  }

  archiveRecord(id: string, actor?: string): DirectoryRecordDto {
    const existing = this.recordRow(id);
    if (existing.archived_at) return this.readRecord(id);
    const responsible = normalizedActor(actor);
    const timestamp = nowUtc();
    this.database.transaction(() => {
      this.database
        .prepare(
          `UPDATE directory_records
           SET archived_at = ?, archived_by = ?, updated_by = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(timestamp, responsible, responsible, timestamp, id);
      for (const table of [
        "directory_group_links",
        "directory_person_links",
        "ticket_record_links",
      ]) {
        this.database
          .prepare(
            `UPDATE ${table}
             SET archived_at = ?, archived_by = ?, updated_by = ?, updated_at = ?
             WHERE record_id = ? AND archived_at IS NULL`,
          )
          .run(timestamp, responsible, responsible, timestamp, id);
      }
      this.database
        .prepare(
          `UPDATE directory_record_links
           SET archived_at = ?, archived_by = ?, updated_by = ?, updated_at = ?
           WHERE (source_record_id = ? OR target_record_id = ?)
             AND archived_at IS NULL`,
        )
        .run(timestamp, responsible, responsible, timestamp, id, id);
    })();
    return this.readRecord(id);
  }

  createSegment(
    input: DirectorySegmentInput,
    actor?: string,
  ): DirectorySegmentDto {
    const normalized = this.normalizeSegmentInput(input);
    const id = randomUUID();
    const responsible = normalizedActor(actor);
    const timestamp = nowUtc();
    this.database
      .prepare(
        `INSERT INTO directory_segments (
           id, name, description, record_type_id, match_mode, filters_json,
           archived_at, archived_by, created_by, updated_by, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
      )
      .run(
        id,
        normalized.name,
        normalized.description,
        normalized.recordTypeId,
        normalized.match,
        JSON.stringify(normalized.filters),
        responsible,
        responsible,
        timestamp,
        timestamp,
      );
    return this.readSegment(id);
  }

  updateSegment(
    id: string,
    input: DirectorySegmentInput,
    actor?: string,
  ): DirectorySegmentDto {
    const existing = this.segmentRow(id);
    if (existing.archived_at) {
      throw new ConflictError("O segmento está arquivado", { id });
    }
    const normalized = this.normalizeSegmentInput(input);
    this.database
      .prepare(
        `UPDATE directory_segments
         SET name = ?, description = ?, record_type_id = ?, match_mode = ?,
             filters_json = ?, updated_by = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        normalized.name,
        normalized.description,
        normalized.recordTypeId,
        normalized.match,
        JSON.stringify(normalized.filters),
        normalizedActor(actor),
        nowUtc(),
        id,
      );
    return this.readSegment(id);
  }

  deleteSegment(id: string): void {
    const existing = this.segmentRow(id);
    if (existing.archived_at) return;
    const timestamp = nowUtc();
    this.database
      .prepare(
        `UPDATE directory_segments
         SET archived_at = ?, archived_by = ?, updated_by = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(timestamp, DEFAULT_ACTOR, DEFAULT_ACTOR, timestamp, id);
  }

  private normalizeRecordTypeInput(
    input: DirectoryRecordTypeInput,
    existingSlug?: string,
  ): NormalizedRecordTypeInput {
    const name = normalizedText(input.name, "Nome do tipo", MAX_NAME_LENGTH);
    return {
      name,
      pluralName: normalizedText(
        input.pluralName,
        "Nome plural do tipo",
        MAX_NAME_LENGTH,
      ),
      slug: normalizeSlug(input.slug, existingSlug ?? name),
      description: normalizedOptionalText(
        input.description,
        "Descrição",
        MAX_DESCRIPTION_LENGTH,
      ),
      icon: normalizedOptionalText(input.icon, "Ícone", 80),
      color: normalizedOptionalText(input.color, "Cor", 80),
    };
  }

  private normalizeFieldInput(
    input: DirectoryFieldDefinitionInput,
    defaultPosition: number,
    existingKey?: string,
  ): NormalizedFieldInput {
    const recordTypeId = normalizedText(input.recordTypeId, "Tipo de registro", 200);
    const label = normalizedText(input.label, "Nome do campo", MAX_NAME_LENGTH);
    if (!DIRECTORY_FIELD_TYPE_SET.has(input.type)) {
      throw new ValidationError("Tipo de campo inválido", { type: input.type });
    }
    const options = (input.options ?? []).map((option) =>
      normalizedText(option, "Opção", 160),
    );
    if (options.length > MAX_OPTIONS) {
      throw new ValidationError(`Um campo pode ter no máximo ${MAX_OPTIONS} opções`);
    }
    const normalizedOptions = options.map((option) =>
      option.toLocaleLowerCase("pt-BR"),
    );
    if (new Set(normalizedOptions).size !== normalizedOptions.length) {
      throw new ValidationError("As opções do campo não podem se repetir");
    }
    const isOptionField = input.type === "select" || input.type === "multi_select";
    if (isOptionField && options.length === 0) {
      throw new ValidationError("Campos de seleção precisam de ao menos uma opção");
    }
    if (!isOptionField && options.length > 0) {
      throw new ValidationError("Apenas campos de seleção aceitam opções");
    }
    const relationRecordTypeId = normalizedOptionalText(
      input.relationRecordTypeId,
      "Tipo relacionado",
      200,
    );
    if (input.type === "relation" && !relationRecordTypeId) {
      throw new ValidationError("Campos de relação precisam de um tipo relacionado");
    }
    if (input.type !== "relation" && relationRecordTypeId) {
      throw new ValidationError("Somente campos de relação aceitam um tipo relacionado");
    }
    const position = input.position ?? defaultPosition;
    if (!Number.isSafeInteger(position) || position < 0 || position > 100_000) {
      throw new ValidationError("Posição do campo inválida", { position });
    }
    return {
      recordTypeId,
      key: normalizeFieldKey(input.key, existingKey ?? label),
      label,
      type: input.type,
      required: input.required ?? false,
      options,
      relationRecordTypeId,
      position,
    };
  }

  private normalizeRecordInput(
    input: DirectoryRecordInput,
    defaults?: {
      slug: string;
      values: Record<string, DirectoryFieldValue>;
      groupIds: string[];
      personIds: string[];
      relatedRecordIds: string[];
    },
  ): NormalizedRecordInput {
    const name = normalizedText(input.name, "Nome do registro", MAX_NAME_LENGTH);
    return {
      typeId: normalizedText(input.typeId, "Tipo de registro", 200),
      name,
      slug: normalizeSlug(input.slug, defaults?.slug ?? name),
      description: normalizedOptionalText(
        input.description,
        "Descrição",
        MAX_DESCRIPTION_LENGTH,
      ),
      values: input.values ?? defaults?.values ?? {},
      groupIds:
        input.groupIds === undefined && defaults
          ? defaults.groupIds
          : uniqueIds(input.groupIds, "Grupos"),
      personIds:
        input.personIds === undefined && defaults
          ? defaults.personIds
          : this.canonicalizeParticipantIds(uniqueIds(input.personIds, "Pessoas")),
      relatedRecordIds:
        input.relatedRecordIds === undefined && defaults
          ? defaults.relatedRecordIds
          : uniqueIds(input.relatedRecordIds, "Registros relacionados"),
    };
  }

  private normalizeSegmentInput(
    input: DirectorySegmentInput,
  ): NormalizedSegmentInput {
    if (input.match !== "all" && input.match !== "any") {
      throw new ValidationError("Modo de correspondência do segmento inválido");
    }
    const recordTypeId = normalizedOptionalText(
      input.recordTypeId,
      "Tipo de registro",
      200,
    );
    if (recordTypeId) this.assertActiveRecordType(recordTypeId);
    if (input.filters.length > 50) {
      throw new ValidationError("Um segmento pode ter no máximo 50 filtros");
    }
    if (input.filters.length > 0 && !recordTypeId) {
      throw new ValidationError(
        "Selecione um tipo de registro antes de adicionar filtros",
      );
    }
    const fields = new Map(this.readFields().map((field) => [field.id, field]));
    const filters = input.filters.map((filter) => {
      const field = fields.get(filter.fieldId);
      if (!field || field.archivedAt) {
        throw new NotFoundError("Campo do diretório", filter.fieldId);
      }
      if (recordTypeId && field.recordTypeId !== recordTypeId) {
        throw new ValidationError("O filtro pertence a outro tipo de registro", {
          fieldId: filter.fieldId,
          recordTypeId,
        });
      }
      if (!DIRECTORY_SEGMENT_OPERATOR_SET.has(filter.operator)) {
        throw new ValidationError("Operador de segmento inválido", {
          operator: filter.operator,
        });
      }
      this.validateSegmentFilter(field, filter);
      return filter;
    });
    return {
      name: normalizedText(input.name, "Nome do segmento", MAX_NAME_LENGTH),
      description: normalizedOptionalText(
        input.description,
        "Descrição",
        MAX_DESCRIPTION_LENGTH,
      ),
      recordTypeId,
      match: input.match,
      filters,
    };
  }

  private validateRecordState(
    recordId: string,
    input: NormalizedRecordInput,
  ): DirectoryFieldDefinitionDto[] {
    this.assertActiveRecordType(input.typeId);
    const fields = this.readFields().filter(
      (field) => field.recordTypeId === input.typeId && !field.archivedAt,
    );
    const fieldById = new Map(fields.map((field) => [field.id, field]));
    for (const [fieldId, value] of Object.entries(input.values)) {
      const field = fieldById.get(fieldId);
      if (!field) {
        throw new ValidationError("O valor pertence a um campo de outro tipo", {
          fieldId,
          typeId: input.typeId,
        });
      }
      this.validateFieldValue(field, value);
      this.assertRelationTargets(field, value);
      if (
        field.type === "relation" &&
        (value === recordId || (Array.isArray(value) && value.includes(recordId)))
      ) {
        throw new ValidationError("Um registro não pode se relacionar consigo mesmo", {
          fieldId,
        });
      }
    }
    for (const field of fields) {
      if (field.required && isEmptyValue(input.values[field.id])) {
        throw new ValidationError(`O campo ${field.label} é obrigatório`, {
          fieldId: field.id,
        });
      }
    }
    this.assertRealGroups(input.groupIds);
    this.assertParticipants(input.personIds);
    this.assertRelatedRecords(recordId, input.relatedRecordIds);
    return fields;
  }

  private validateFieldValue(
    field: DirectoryFieldDefinitionDto,
    value: DirectoryFieldValue,
  ): void {
    if (value === null) {
      if (field.required) {
        throw new ValidationError(`O campo ${field.label} é obrigatório`);
      }
      return;
    }
    switch (field.type) {
      case "text":
        if (typeof value !== "string" || value.length > MAX_FIELD_VALUE_LENGTH) {
          throw new ValidationError(`Valor inválido para ${field.label}`);
        }
        return;
      case "number":
        if (typeof value !== "number" || !Number.isFinite(value)) {
          throw new ValidationError(`Valor numérico inválido para ${field.label}`);
        }
        return;
      case "boolean":
        if (typeof value !== "boolean") {
          throw new ValidationError(`Valor booleano inválido para ${field.label}`);
        }
        return;
      case "date":
        if (typeof value !== "string" || !this.isCalendarDate(value)) {
          throw new ValidationError(`Data inválida para ${field.label}`);
        }
        return;
      case "url":
        if (typeof value !== "string" || !this.isSafeUrl(value)) {
          throw new ValidationError(`URL inválida para ${field.label}`);
        }
        return;
      case "select":
        if (typeof value !== "string" || !field.options.includes(value)) {
          throw new ValidationError(`Opção inválida para ${field.label}`);
        }
        return;
      case "multi_select":
        if (
          !Array.isArray(value) ||
          new Set(value).size !== value.length ||
          value.some((option) => !field.options.includes(option))
        ) {
          throw new ValidationError(`Opções inválidas para ${field.label}`);
        }
        return;
      case "relation":
        if (
          !(
            typeof value === "string" ||
            (Array.isArray(value) &&
              value.length > 0 &&
              value.every((item) => typeof item === "string") &&
              new Set(value).size === value.length)
          )
        ) {
          throw new ValidationError(`Relação inválida para ${field.label}`);
        }
    }
  }

  private validateSegmentFilter(
    field: DirectoryFieldDefinitionDto,
    filter: DirectorySegmentFilterDto,
  ): void {
    if (filter.operator === "is_empty" || filter.operator === "is_not_empty") {
      return;
    }
    if (filter.value === undefined || filter.value === null) {
      throw new ValidationError("O filtro precisa de um valor", {
        fieldId: field.id,
      });
    }
    if (
      (filter.operator === "greater_than" || filter.operator === "less_than") &&
      field.type !== "number" &&
      field.type !== "date"
    ) {
      throw new ValidationError("Este operador aceita apenas números ou datas", {
        fieldId: field.id,
      });
    }
    if (
      (filter.operator === "contains" || filter.operator === "not_contains") &&
      (field.type === "boolean" || field.type === "number" || field.type === "date")
    ) {
      throw new ValidationError("Este tipo de campo não aceita busca por conteúdo", {
        fieldId: field.id,
      });
    }
    if (
      (field.type === "multi_select" || field.type === "relation") &&
      (filter.operator === "contains" || filter.operator === "not_contains") &&
      typeof filter.value === "string"
    ) {
      if (field.type === "relation") this.assertRelationTargets(field, filter.value);
      if (field.type === "multi_select" && !field.options.includes(filter.value)) {
        throw new ValidationError(`Opção inválida para ${field.label}`);
      }
      return;
    }
    this.validateFieldValue(field, filter.value);
    this.assertRelationTargets(field, filter.value);
  }

  private assertRelationTargets(
    field: DirectoryFieldDefinitionDto,
    value: DirectoryFieldValue,
  ): void {
    if (field.type !== "relation" || value === null) return;
    const ids = Array.isArray(value)
      ? value
      : typeof value === "string"
        ? [value]
        : [];
    if (ids.length === 0) {
      throw new ValidationError(`Relação inválida para ${field.label}`);
    }
    for (const id of ids) {
      const row = this.database
        .prepare(
          `SELECT record_type_id, archived_at
           FROM directory_records WHERE id = ?`,
        )
        .get(id) as
        | { record_type_id: string; archived_at: string | null }
        | undefined;
      if (!row) {
        throw new ValidationError("O valor aponta para um registro inexistente", {
          fieldId: field.id,
          recordId: id,
        });
      }
      if (row.archived_at) {
        throw new ValidationError("O valor aponta para um registro arquivado", {
          fieldId: field.id,
          recordId: id,
        });
      }
      if (row.record_type_id !== field.relationRecordTypeId) {
        throw new ValidationError("O registro relacionado pertence a outro tipo", {
          fieldId: field.id,
          recordId: id,
        });
      }
    }
  }

  private assertRelationRecordType(input: NormalizedFieldInput): void {
    if (input.relationRecordTypeId) {
      this.assertActiveRecordType(input.relationRecordTypeId);
    }
  }

  private assertActiveRecordType(id: string): void {
    const row = this.database
      .prepare("SELECT archived_at FROM directory_record_types WHERE id = ?")
      .get(id) as { archived_at: string | null } | undefined;
    if (!row) throw new NotFoundError("Tipo de registro", id);
    if (row.archived_at) {
      throw new ConflictError("O tipo de registro está arquivado", { id });
    }
  }

  private assertRealGroups(ids: string[]): void {
    for (const id of ids) {
      const group = this.database
        .prepare("SELECT external_jid FROM whatsapp_groups WHERE id = ?")
        .get(id) as { external_jid: string } | undefined;
      if (!group) throw new NotFoundError("Grupo", id);
      if (!group.external_jid.endsWith("@g.us")) {
        throw new ValidationError("Somente grupos podem ser associados ao diretório", {
          id,
        });
      }
    }
  }

  private assertParticipants(ids: string[]): void {
    for (const id of ids) {
      const found = this.database
        .prepare("SELECT 1 AS found FROM participants WHERE id = ?")
        .get(id) as { found: number } | undefined;
      if (!found) throw new NotFoundError("Pessoa", id);
    }
  }

  private assertRelatedRecords(recordId: string, ids: string[]): void {
    for (const id of ids) {
      if (id === recordId) {
        throw new ValidationError("Um registro não pode se relacionar consigo mesmo");
      }
      const row = this.database
        .prepare("SELECT archived_at FROM directory_records WHERE id = ?")
        .get(id) as { archived_at: string | null } | undefined;
      if (!row) throw new NotFoundError("Registro relacionado", id);
      if (row.archived_at) {
        throw new ConflictError("O registro relacionado está arquivado", { id });
      }
    }
  }

  private replaceRecordValues(
    recordId: string,
    values: Record<string, DirectoryFieldValue>,
    fields: DirectoryFieldDefinitionDto[],
    actor: string,
    timestamp: string,
  ): void {
    this.database
      .prepare("DELETE FROM directory_field_values WHERE record_id = ?")
      .run(recordId);
    const fieldIds = new Set(fields.map((field) => field.id));
    const statement = this.database.prepare(
      `INSERT INTO directory_field_values (
         record_id, field_id, value_json, created_by, updated_by, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const [fieldId, value] of Object.entries(values)) {
      if (!fieldIds.has(fieldId)) continue;
      statement.run(
        recordId,
        fieldId,
        JSON.stringify(value),
        actor,
        actor,
        timestamp,
        timestamp,
      );
    }
  }

  private replaceGroupLinks(
    recordId: string,
    ids: string[],
    actor: string,
    timestamp: string,
  ): void {
    this.archiveAssociations(
      "directory_group_links",
      "record_id",
      recordId,
      actor,
      timestamp,
    );
    const statement = this.database.prepare(
      `INSERT INTO directory_group_links (
         record_id, group_id, archived_at, archived_by, created_by, updated_by,
         created_at, updated_at
       ) VALUES (?, ?, NULL, NULL, ?, ?, ?, ?)
       ON CONFLICT(record_id, group_id) DO UPDATE SET
         archived_at = NULL,
         archived_by = NULL,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
    );
    for (const id of ids) {
      statement.run(recordId, id, actor, actor, timestamp, timestamp);
    }
  }

  private replacePersonLinks(
    recordId: string,
    ids: string[],
    actor: string,
    timestamp: string,
  ): void {
    this.archiveAssociations(
      "directory_person_links",
      "record_id",
      recordId,
      actor,
      timestamp,
    );
    const statement = this.database.prepare(
      `INSERT INTO directory_person_links (
         record_id, participant_id, archived_at, archived_by, created_by, updated_by,
         created_at, updated_at
       ) VALUES (?, ?, NULL, NULL, ?, ?, ?, ?)
       ON CONFLICT(record_id, participant_id) DO UPDATE SET
         archived_at = NULL,
         archived_by = NULL,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
    );
    for (const id of ids) {
      statement.run(recordId, id, actor, actor, timestamp, timestamp);
    }
  }

  private replaceRelatedLinks(
    recordId: string,
    ids: string[],
    actor: string,
    timestamp: string,
  ): void {
    this.database
      .prepare(
        `UPDATE directory_record_links
         SET archived_at = ?, archived_by = ?, updated_by = ?, updated_at = ?
         WHERE relationship_key = 'related'
           AND field_definition_id IS NULL
           AND (source_record_id = ? OR target_record_id = ?)
           AND archived_at IS NULL`,
      )
      .run(timestamp, actor, actor, timestamp, recordId, recordId);
    for (const targetId of ids) {
      this.restoreOrCreateRecordLink(
        recordId,
        targetId,
        "related",
        null,
        actor,
        timestamp,
      );
    }
  }

  private replaceFieldRelationLinks(
    recordId: string,
    fields: DirectoryFieldDefinitionDto[],
    values: Record<string, DirectoryFieldValue>,
    actor: string,
    timestamp: string,
  ): void {
    this.database
      .prepare(
        `UPDATE directory_record_links
         SET archived_at = ?, archived_by = ?, updated_by = ?, updated_at = ?
         WHERE source_record_id = ?
           AND field_definition_id IS NOT NULL
           AND archived_at IS NULL`,
      )
      .run(timestamp, actor, actor, timestamp, recordId);
    for (const field of fields) {
      if (field.type !== "relation") continue;
      const value = values[field.id];
      if (value === null || value === undefined) continue;
      const ids = Array.isArray(value)
        ? value
        : typeof value === "string"
          ? [value]
          : [];
      for (const targetId of ids) {
        this.restoreOrCreateRecordLink(
          recordId,
          targetId,
          `field:${field.key}`,
          field.id,
          actor,
          timestamp,
        );
      }
    }
  }

  private restoreOrCreateRecordLink(
    sourceId: string,
    targetId: string,
    relationshipKey: string,
    fieldId: string | null,
    actor: string,
    timestamp: string,
  ): void {
    const existing = this.database
      .prepare(
        `SELECT id
         FROM directory_record_links
         WHERE source_record_id = ? AND target_record_id = ?
           AND relationship_key = ?
           AND field_definition_id IS ?
         ORDER BY CASE WHEN archived_at IS NULL THEN 0 ELSE 1 END, updated_at DESC
         LIMIT 1`,
      )
      .get(sourceId, targetId, relationshipKey, fieldId) as
      | { id: string }
      | undefined;
    if (existing) {
      this.database
        .prepare(
          `UPDATE directory_record_links
           SET archived_at = NULL, archived_by = NULL,
               updated_by = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(actor, timestamp, existing.id);
      return;
    }
    this.database
      .prepare(
        `INSERT INTO directory_record_links (
           id, source_record_id, target_record_id, field_definition_id,
           relationship_key, archived_at, archived_by, created_by, updated_by,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        sourceId,
        targetId,
        fieldId,
        relationshipKey,
        actor,
        actor,
        timestamp,
        timestamp,
      );
  }

  private archiveAssociations(
    table: "directory_group_links" | "directory_person_links",
    key: "record_id",
    id: string,
    actor: string,
    timestamp: string,
  ): void {
    this.database
      .prepare(
        `UPDATE ${table}
         SET archived_at = ?, archived_by = ?, updated_by = ?, updated_at = ?
         WHERE ${key} = ? AND archived_at IS NULL`,
      )
      .run(timestamp, actor, actor, timestamp, id);
  }

  private readGroups(): DirectoryGroupDto[] {
    const rows = this.database
      .prepare(
        `SELECT
           group_row.id,
           group_row.subject,
           group_row.external_jid,
           group_row.monitored,
           (SELECT COUNT(DISTINCT COALESCE(
              identity.phone_jid,
              NULLIF(participant.phone_e164, ''),
              participant.external_jid
            ))
            FROM group_participants membership
            JOIN participants participant ON participant.id = membership.participant_id
            LEFT JOIN whatsapp_identity_links identity
              ON identity.phone_jid = participant.external_jid
              OR identity.lid_jid = participant.external_jid
            WHERE membership.group_id = group_row.id AND membership.active = 1
           ) AS participant_count,
           (SELECT COUNT(*) FROM tickets ticket
            WHERE ticket.group_id = group_row.id) AS ticket_count,
           (SELECT COUNT(*) FROM tickets ticket
            WHERE ticket.group_id = group_row.id
              AND ticket.status NOT IN ('resolved', 'archived')) AS open_ticket_count,
           (SELECT MAX(message.occurred_at) FROM messages message
            WHERE message.group_id = group_row.id) AS last_activity_at
         FROM whatsapp_groups group_row
         WHERE group_row.external_jid LIKE '%@g.us'
         ORDER BY group_row.subject COLLATE NOCASE, group_row.id`,
      )
      .all() as Array<{
      id: string;
      subject: string;
      external_jid: string;
      monitored: number;
      participant_count: number;
      ticket_count: number;
      open_ticket_count: number;
      last_activity_at: string | null;
    }>;
    const linkedRecords = this.readReverseLinkMap(
      "directory_group_links",
      "group_id",
      "record_id",
    );
    return rows.map((row) => ({
      id: row.id,
      subject: row.subject,
      externalJid: row.external_jid,
      monitored: Boolean(row.monitored),
      participantCount: row.participant_count,
      ticketCount: row.ticket_count,
      openTicketCount: row.open_ticket_count,
      lastActivityAt: row.last_activity_at,
      linkedRecordIds: linkedRecords.get(row.id) ?? [],
    }));
  }

  private readPeople(
    personIdsByRecord: Map<string, string[]>,
  ): CanonicalPeopleResult {
    const canonical = canonicalPersonGroups(
      this.readPersonRows(),
      this.readIdentityLinks(),
    );
    const activeGroupIdsByParticipant = new Map<string, Set<string>>();
    const memberships = this.database
      .prepare(
        `SELECT membership.participant_id, membership.group_id
         FROM group_participants membership
         JOIN whatsapp_groups group_row ON group_row.id = membership.group_id
         WHERE membership.active = 1
           AND group_row.external_jid LIKE '%@g.us'`,
      )
      .all() as Array<{ participant_id: string; group_id: string }>;
    for (const membership of memberships) {
      const groups = activeGroupIdsByParticipant.get(membership.participant_id) ??
        new Set<string>();
      groups.add(membership.group_id);
      activeGroupIdsByParticipant.set(membership.participant_id, groups);
    }

    const linkedRecordIdsByParticipant = new Map<string, Set<string>>();
    for (const [recordId, participantIds] of personIdsByRecord) {
      for (const participantId of participantIds) {
        const records = linkedRecordIdsByParticipant.get(participantId) ??
          new Set<string>();
        records.add(recordId);
        linkedRecordIdsByParticipant.set(participantId, records);
      }
    }

    const people = canonical.groups.flatMap((group) => {
      const activeGroupIds = new Set(
        group.aliases.flatMap((alias) => [
          ...(activeGroupIdsByParticipant.get(alias.id) ?? []),
        ]),
      );
      const lastActivityAt = latestTimestamp(
        ...group.aliases.map((alias) => alias.last_activity_at),
      );
      if (activeGroupIds.size === 0 && !lastActivityAt) return [];

      const humanName = group.aliases
        .filter((alias) => isHumanDisplayName(alias.display_name, group.aliases))
        .toSorted(
          (left, right) =>
            right.updated_at.localeCompare(left.updated_at) ||
            Number(right.id === group.representative.id) -
              Number(left.id === group.representative.id) ||
            left.id.localeCompare(right.id),
        )[0]?.display_name.trim();
      const phoneE164 =
        phoneFromJid(group.canonicalJid) ??
        group.aliases
          .map((alias) => normalizedPhone(alias.phone_e164))
          .find((phone): phone is string => Boolean(phone)) ??
        null;
      const linkedRecordIds = new Set(
        group.aliases.flatMap((alias) => [
          ...(linkedRecordIdsByParticipant.get(alias.id) ?? []),
        ]),
      );
      if (!humanName && !phoneE164 && linkedRecordIds.size === 0) return [];

      return [{
        id: group.representative.id,
        displayName: humanName ?? phoneE164 ?? group.canonicalJid,
        phoneE164,
        externalJid: group.canonicalJid,
        isStaff: group.aliases.some((alias) => Boolean(alias.is_staff)),
        activeGroupCount: activeGroupIds.size,
        lastActivityAt,
        linkedRecordIds: [...linkedRecordIds].sort(),
      } satisfies DirectoryPersonDto];
    });
    people.sort(
      (left, right) =>
        left.displayName.localeCompare(right.displayName, "pt-BR", {
          sensitivity: "base",
        }) || left.id.localeCompare(right.id),
    );
    return {
      people,
      canonicalIdByParticipantId: canonical.canonicalIdByParticipantId,
    };
  }

  private readPersonRows(): PersonRow[] {
    return this.database
      .prepare(
        `SELECT
           participant.id,
           participant.display_name,
           participant.phone_e164,
           participant.external_jid,
           participant.created_at,
           participant.updated_at,
           EXISTS (
             SELECT 1 FROM staff_members staff
             WHERE staff.participant_id = participant.id AND staff.active = 1
           ) AS is_staff,
           activity.last_activity_at
         FROM participants participant
         LEFT JOIN (
           SELECT sender_id, MAX(occurred_at) AS last_activity_at
           FROM messages
           GROUP BY sender_id
         ) activity ON activity.sender_id = participant.id`,
      )
      .all() as PersonRow[];
  }

  private readIdentityLinks(): IdentityLinkRow[] {
    return this.database
      .prepare(
        `SELECT phone_jid, lid_jid
         FROM whatsapp_identity_links
         ORDER BY phone_jid, lid_jid`,
      )
      .all() as IdentityLinkRow[];
  }

  private canonicalizeParticipantIds(ids: string[]): string[] {
    if (ids.length === 0) return [];
    const { canonicalIdByParticipantId } = canonicalPersonGroups(
      this.readPersonRows(),
      this.readIdentityLinks(),
    );
    return [
      ...new Set(
        ids.map((id) => canonicalIdByParticipantId.get(id) ?? id),
      ),
    ];
  }

  private readRecords(
    valuesByRecord: Map<string, Record<string, DirectoryFieldValue>>,
    groupIdsByRecord: Map<string, string[]>,
    personIdsByRecord: Map<string, string[]>,
    relatedRecordIdsByRecord: Map<string, string[]>,
  ): DirectoryRecordDto[] {
    const rows = this.database
      .prepare(
        `SELECT
           record.id,
           record.record_type_id,
           record.legacy_client_id,
           record.name,
           record.slug,
           record.description,
           record.archived_at,
           record.created_at,
           record.updated_at,
           (SELECT COUNT(DISTINCT ticket.id)
            FROM tickets ticket
            WHERE EXISTS (
              SELECT 1 FROM ticket_record_links link
              WHERE link.record_id = record.id
                AND link.ticket_id = ticket.id
                AND link.archived_at IS NULL
            )
            OR EXISTS (
              SELECT 1 FROM directory_group_links group_link
              WHERE group_link.record_id = record.id
                AND group_link.group_id = ticket.group_id
                AND group_link.archived_at IS NULL
            )
           ) AS ticket_count,
           (SELECT COUNT(DISTINCT ticket.id)
            FROM tickets ticket
            WHERE ticket.status NOT IN ('resolved', 'archived')
              AND (
                EXISTS (
                  SELECT 1 FROM ticket_record_links link
                  WHERE link.record_id = record.id
                    AND link.ticket_id = ticket.id
                    AND link.archived_at IS NULL
                )
                OR EXISTS (
                  SELECT 1 FROM directory_group_links group_link
                  WHERE group_link.record_id = record.id
                    AND group_link.group_id = ticket.group_id
                    AND group_link.archived_at IS NULL
                )
              )
           ) AS open_ticket_count,
           (SELECT MAX(message.occurred_at)
            FROM directory_group_links group_link
            JOIN messages message ON message.group_id = group_link.group_id
            WHERE group_link.record_id = record.id
              AND group_link.archived_at IS NULL
           ) AS group_activity_at,
           (SELECT MAX(ticket.last_message_at)
            FROM tickets ticket
            WHERE EXISTS (
              SELECT 1 FROM ticket_record_links ticket_link
              WHERE ticket_link.record_id = record.id
                AND ticket_link.ticket_id = ticket.id
                AND ticket_link.archived_at IS NULL
            )
            OR EXISTS (
              SELECT 1 FROM directory_group_links group_link
              WHERE group_link.record_id = record.id
                AND group_link.group_id = ticket.group_id
                AND group_link.archived_at IS NULL
            )
           ) AS ticket_activity_at
         FROM directory_records record
         ORDER BY record.archived_at IS NOT NULL, record.name COLLATE NOCASE, record.id`,
      )
      .all() as RecordRow[];
    return rows.map((row) => ({
      id: row.id,
      typeId: row.record_type_id,
      legacyClientId: row.legacy_client_id,
      name: row.name,
      slug: row.slug,
      description: row.description,
      archivedAt: row.archived_at,
      values: valuesByRecord.get(row.id) ?? {},
      groupIds: groupIdsByRecord.get(row.id) ?? [],
      personIds: personIdsByRecord.get(row.id) ?? [],
      relatedRecordIds: relatedRecordIdsByRecord.get(row.id) ?? [],
      ticketCount: row.ticket_count,
      openTicketCount: row.open_ticket_count,
      lastActivityAt: latestTimestamp(
        row.group_activity_at,
        row.ticket_activity_at,
      ),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  private readRecordTypes(
    counts: Map<string, number>,
  ): DirectoryRecordTypeDto[] {
    const rows = this.database
      .prepare(
        `SELECT id, name, plural_name, slug, description, icon, color, system,
                archived_at, created_at, updated_at
         FROM directory_record_types
         ORDER BY archived_at IS NOT NULL, system DESC, name COLLATE NOCASE`,
      )
      .all() as RecordTypeRow[];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      pluralName: row.plural_name,
      slug: row.slug,
      description: row.description,
      icon: row.icon,
      color: row.color,
      system: Boolean(row.system),
      archivedAt: row.archived_at,
      recordCount: counts.get(row.id) ?? 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  private readFields(): DirectoryFieldDefinitionDto[] {
    return (
      this.database
        .prepare(
          `SELECT id, record_type_id, key, label, field_type, required,
                  options_json, relation_record_type_id, position, archived_at,
                  created_at, updated_at
           FROM directory_field_definitions
           ORDER BY archived_at IS NOT NULL, record_type_id, position, label COLLATE NOCASE`,
        )
        .all() as FieldRow[]
    ).map(rowToField);
  }

  private readSegments(
    records: DirectoryRecordDto[],
    fields: DirectoryFieldDefinitionDto[],
  ): DirectorySegmentDto[] {
    const fieldById = new Map(fields.map((field) => [field.id, field]));
    const rows = this.database
      .prepare(
        `SELECT id, name, description, record_type_id, match_mode, filters_json,
                created_at, updated_at
         FROM directory_segments
         WHERE archived_at IS NULL
         ORDER BY name COLLATE NOCASE, id`,
      )
      .all() as SegmentRow[];
    return rows.map((row) => {
      const filters = parsedFilters(row.filters_json).filter((filter) =>
        fieldById.has(filter.fieldId),
      );
      const candidates = row.record_type_id
        ? records.filter((record) => record.typeId === row.record_type_id)
        : records;
      const memberRecordIds = candidates
        .filter((record) => {
          if (filters.length === 0) return true;
          const results = filters.map((filter) =>
            matchesFilter(record.values[filter.fieldId], filter),
          );
          return row.match_mode === "all"
            ? results.every(Boolean)
            : results.some(Boolean);
        })
        .map((record) => record.id);
      return {
        id: row.id,
        name: row.name,
        description: row.description,
        recordTypeId: row.record_type_id,
        match: row.match_mode,
        filters,
        memberCount: memberRecordIds.length,
        memberRecordIds,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });
  }

  private readValuesByRecord(): Map<
    string,
    Record<string, DirectoryFieldValue>
  > {
    const rows = this.database
      .prepare(
        `SELECT value.record_id, value.field_id, value.value_json
         FROM directory_field_values value
         JOIN directory_field_definitions field ON field.id = value.field_id
         WHERE field.archived_at IS NULL`,
      )
      .all() as Array<{
      record_id: string;
      field_id: string;
      value_json: string;
    }>;
    const result = new Map<string, Record<string, DirectoryFieldValue>>();
    for (const row of rows) {
      const current = result.get(row.record_id) ?? {};
      current[row.field_id] = parsedFieldValue(row.value_json);
      result.set(row.record_id, current);
    }
    return result;
  }

  private readRelatedRecordIds(): Map<string, string[]> {
    const rows = this.database
      .prepare(
        `SELECT source_record_id, target_record_id
         FROM directory_record_links
         WHERE archived_at IS NULL`,
      )
      .all() as Array<{
      source_record_id: string;
      target_record_id: string;
    }>;
    const result = new Map<string, Set<string>>();
    for (const row of rows) {
      const source = result.get(row.source_record_id) ?? new Set<string>();
      source.add(row.target_record_id);
      result.set(row.source_record_id, source);
      const target = result.get(row.target_record_id) ?? new Set<string>();
      target.add(row.source_record_id);
      result.set(row.target_record_id, target);
    }
    return new Map(
      [...result].map(([id, values]) => [id, [...values].sort()]),
    );
  }

  private readLinkMap(
    table: "directory_group_links" | "directory_person_links",
    keyColumn: "record_id",
    valueColumn: "group_id" | "participant_id",
  ): Map<string, string[]> {
    const rows = this.database
      .prepare(
        `SELECT ${keyColumn} AS key, ${valueColumn} AS value
         FROM ${table}
         WHERE archived_at IS NULL
         ORDER BY ${keyColumn}, ${valueColumn}`,
      )
      .all() as Array<{ key: string; value: string }>;
    const result = new Map<string, string[]>();
    for (const row of rows) {
      result.set(row.key, [...(result.get(row.key) ?? []), row.value]);
    }
    return result;
  }

  private readReverseLinkMap(
    table: "directory_group_links" | "directory_person_links",
    keyColumn: "group_id" | "participant_id",
    valueColumn: "record_id",
  ): Map<string, string[]> {
    const rows = this.database
      .prepare(
        `SELECT ${keyColumn} AS key, ${valueColumn} AS value
         FROM ${table}
         WHERE archived_at IS NULL
         ORDER BY ${keyColumn}, ${valueColumn}`,
      )
      .all() as Array<{ key: string; value: string }>;
    const result = new Map<string, string[]>();
    for (const row of rows) {
      result.set(row.key, [...(result.get(row.key) ?? []), row.value]);
    }
    return result;
  }

  private readRecordType(id: string): DirectoryRecordTypeDto {
    const counts = new Map([[id, this.activeRecordCount(id)]]);
    const type = this.readRecordTypes(counts).find((item) => item.id === id);
    if (!type) throw new NotFoundError("Tipo de registro", id);
    return type;
  }

  private readField(id: string): DirectoryFieldDefinitionDto {
    const field = this.readFields().find((item) => item.id === id);
    if (!field) throw new NotFoundError("Campo do diretório", id);
    return field;
  }

  private readRecord(id: string): DirectoryRecordDto {
    const record = this.getSnapshot().records.find((item) => item.id === id);
    if (!record) throw new NotFoundError("Registro do diretório", id);
    return record;
  }

  private readSegment(id: string): DirectorySegmentDto {
    const segment = this.getSnapshot().segments.find((item) => item.id === id);
    if (!segment) throw new NotFoundError("Segmento", id);
    return segment;
  }

  private recordTypeRow(id: string): RecordTypeRow {
    const row = this.database
      .prepare(
        `SELECT id, name, plural_name, slug, description, icon, color, system,
                archived_at, created_at, updated_at
         FROM directory_record_types WHERE id = ?`,
      )
      .get(id) as RecordTypeRow | undefined;
    if (!row) throw new NotFoundError("Tipo de registro", id);
    return row;
  }

  private fieldRow(id: string): FieldRow {
    const row = this.database
      .prepare(
        `SELECT id, record_type_id, key, label, field_type, required,
                options_json, relation_record_type_id, position, archived_at,
                created_at, updated_at
         FROM directory_field_definitions WHERE id = ?`,
      )
      .get(id) as FieldRow | undefined;
    if (!row) throw new NotFoundError("Campo do diretório", id);
    return row;
  }

  private recordRow(id: string): RecordRow {
    const row = this.database
      .prepare(
        `SELECT id, record_type_id, legacy_client_id, name, slug, description,
                archived_at, created_at, updated_at,
                0 AS ticket_count, 0 AS open_ticket_count,
                NULL AS group_activity_at, NULL AS ticket_activity_at
         FROM directory_records WHERE id = ?`,
      )
      .get(id) as RecordRow | undefined;
    if (!row) throw new NotFoundError("Registro do diretório", id);
    return row;
  }

  private segmentRow(id: string): SegmentRow & { archived_at: string | null } {
    const row = this.database
      .prepare(
        `SELECT id, name, description, record_type_id, match_mode, filters_json,
                archived_at, created_at, updated_at
         FROM directory_segments WHERE id = ?`,
      )
      .get(id) as (SegmentRow & { archived_at: string | null }) | undefined;
    if (!row) throw new NotFoundError("Segmento", id);
    return row;
  }

  private activeRecordCount(typeId: string): number {
    return (
      this.database
        .prepare(
          `SELECT COUNT(*) AS count FROM directory_records
           WHERE record_type_id = ? AND archived_at IS NULL`,
        )
        .get(typeId) as { count: number }
    ).count;
  }

  private nextFieldPosition(typeId: string): number {
    const row = this.database
      .prepare(
        `SELECT COALESCE(MAX(position), -10) + 10 AS position
         FROM directory_field_definitions
         WHERE record_type_id = ?`,
      )
      .get(typeId) as { position: number };
    return row.position;
  }

  private isCalendarDate(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
  }

  private isSafeUrl(value: string): boolean {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }

  private rethrowConstraint(error: unknown, message: string): never {
    if (isSqliteConstraint(error)) throw new ConflictError(message);
    throw error;
  }
}
