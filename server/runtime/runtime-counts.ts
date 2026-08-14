import type { SupportDatabase } from "../db/index.js";

export interface RuntimeCounts {
  messagesStored: number;
  groupsDiscovered: number;
  groupsSynced: number;
  privateConversations: number;
  ticketsCreated: number;
  monitoredGroups: number;
}

export function readRuntimeCounts(database: SupportDatabase): RuntimeCounts {
  const row = database
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM messages) AS messages_stored,
        (SELECT COUNT(*)
         FROM whatsapp_groups
         WHERE external_jid LIKE '%@g.us') AS groups_discovered,
        (SELECT COUNT(DISTINCT conversation.id)
         FROM whatsapp_groups conversation
         JOIN messages message ON message.group_id = conversation.id
         WHERE conversation.external_jid LIKE '%@g.us') AS groups_synced,
        (SELECT COUNT(*)
         FROM whatsapp_groups conversation
         WHERE (conversation.external_jid LIKE '%@s.whatsapp.net'
            OR conversation.external_jid LIKE '%@lid')
           AND EXISTS (
             SELECT 1
             FROM messages message
             WHERE message.group_id = conversation.id
               AND message.message_type NOT IN ('reactionMessage', 'protocolMessage')
               AND (
                 trim(COALESCE(message.text, '')) <> ''
                 OR message.message_type NOT IN (
                   'system', 'protocolMessage', 'reactionMessage'
                 )
                 OR EXISTS (
                   SELECT 1 FROM attachments attachment
                   WHERE attachment.message_id = message.id
                 )
               )
           )) AS private_conversations,
        (SELECT COUNT(*) FROM tickets) AS tickets_created,
        (SELECT COUNT(*)
         FROM whatsapp_groups
         WHERE external_jid LIKE '%@g.us'
           AND monitored = 1) AS monitored_groups`,
    )
    .get() as {
    messages_stored: number;
    groups_discovered: number;
    groups_synced: number;
    private_conversations: number;
    tickets_created: number;
    monitored_groups: number;
  };

  return {
    messagesStored: row.messages_stored,
    groupsDiscovered: row.groups_discovered,
    groupsSynced: row.groups_synced,
    privateConversations: row.private_conversations,
    ticketsCreated: row.tickets_created,
    monitoredGroups: row.monitored_groups,
  };
}
