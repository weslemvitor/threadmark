import type { SupportDatabase } from "../db/index.js";

const DEFAULT_RESCAN_DAYS = 30;
const MAX_RESCAN_DAYS = 730;
const DAY_IN_MILLISECONDS = 24 * 60 * 60_000;
const EXECUTION_FLAGS = ["--apply", "--execute", "--yes"];

export interface HistoryRescanPreviewArguments {
  days: number;
  requestedJids: string[];
}

export interface HistoryRescanPreviewInput extends HistoryRescanPreviewArguments {
  now?: Date;
}

export interface HistoryRescanPreview {
  cutoff: string;
  days: number;
  messages: number;
  conversations: number;
  oldestAt: string | null;
  newestAt: string | null;
}

export function parseHistoryRescanPreviewArguments(
  argumentsList: readonly string[],
): HistoryRescanPreviewArguments {
  const executionFlag = argumentsList.find((argument) =>
    EXECUTION_FLAGS.some(
      (flag) => argument === flag || argument.startsWith(`${flag}=`),
    ),
  );
  if (executionFlag) {
    throw new Error(
      `O rescan é somente prévia: ${executionFlag} não pode executar alterações nem chamar a IA.`,
    );
  }

  const daysArguments = argumentsList.filter((argument) =>
    argument.startsWith("--days="),
  );
  if (daysArguments.length > 1) {
    throw new Error("Informe --days apenas uma vez.");
  }

  const unknownOption = argumentsList.find(
    (argument) => argument.startsWith("--") && !argument.startsWith("--days="),
  );
  if (unknownOption) {
    throw new Error(`Opção desconhecida no rescan: ${unknownOption}.`);
  }

  const days = Number(daysArguments[0]?.slice("--days=".length) ?? DEFAULT_RESCAN_DAYS);
  assertValidDays(days);

  return {
    days,
    requestedJids: argumentsList.filter((argument) => !argument.startsWith("--")),
  };
}

export function previewHistoryRescan(
  database: SupportDatabase,
  input: HistoryRescanPreviewInput,
): HistoryRescanPreview {
  assertValidDays(input.days);
  const now = input.now ?? new Date();
  if (Number.isNaN(now.getTime())) {
    throw new Error("Data de referência inválida para a prévia do rescan.");
  }

  const cutoff = new Date(
    now.getTime() - input.days * DAY_IN_MILLISECONDS,
  ).toISOString();
  const groupScope = input.requestedJids.length
    ? `AND g.external_jid IN (${input.requestedJids.map(() => "?").join(", ")})`
    : "AND g.monitored = 1";
  const row = database
    .prepare(
      `SELECT
         COUNT(*) AS messages,
         COUNT(DISTINCT m.group_id) AS conversations,
         MIN(m.occurred_at) AS oldest_at,
         MAX(m.occurred_at) AS newest_at
       FROM messages m
       WHERE m.occurred_at >= ?
         AND m.triage_state = 'context'
         AND NOT EXISTS (
           SELECT 1
           FROM staff_members staff
           WHERE staff.participant_id = m.sender_id
             AND staff.active = 1
         )
         AND EXISTS (
           SELECT 1
           FROM whatsapp_groups g
           WHERE g.id = m.group_id
             AND g.suggestions_muted_at IS NULL
             ${groupScope}
         )`,
    )
    .get(cutoff, ...input.requestedJids) as {
    messages: number;
    conversations: number;
    oldest_at: string | null;
    newest_at: string | null;
  };

  return {
    cutoff,
    days: input.days,
    messages: Number(row.messages),
    conversations: Number(row.conversations),
    oldestAt: row.oldest_at,
    newestAt: row.newest_at,
  };
}

function assertValidDays(days: number): void {
  if (!Number.isSafeInteger(days) || days < 1 || days > MAX_RESCAN_DAYS) {
    throw new Error(`--days deve estar entre 1 e ${MAX_RESCAN_DAYS}.`);
  }
}
