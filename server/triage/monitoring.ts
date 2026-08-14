import type { SupportDatabase } from "../db/index.js";

export function updateConversationMonitoring(
  database: SupportDatabase,
  jids: readonly string[],
  enabled: boolean,
  updatedAt = new Date().toISOString(),
): number {
  if (jids.length === 0) return 0;
  const placeholders = jids.map(() => "?").join(", ");
  if (!enabled) {
    return database
      .prepare(
        `UPDATE whatsapp_groups
         SET monitored = 0, updated_at = ?
         WHERE external_jid IN (${placeholders})`,
      )
      .run(updatedAt, ...jids).changes;
  }

  return database
    .prepare(
      `UPDATE whatsapp_groups AS conversation
       SET monitored = 1,
           triage_enabled_at = COALESCE(
             conversation.triage_enabled_at,
             conversation.triage_watermark_at,
             (SELECT MAX(message.occurred_at)
              FROM messages message
              WHERE message.group_id = conversation.id),
             ?
           ),
           triage_watermark_at = COALESCE(
             conversation.triage_watermark_at,
             conversation.triage_enabled_at,
             (SELECT MAX(message.occurred_at)
              FROM messages message
              WHERE message.group_id = conversation.id),
             ?
           ),
           updated_at = ?
       WHERE external_jid IN (${placeholders})`,
    )
    .run(updatedAt, updatedAt, updatedAt, ...jids).changes;
}
