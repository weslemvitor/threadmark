import type { ChannelAttachment, ChannelSource } from "../../shared/channels.js";
import type { SupportDatabase } from "../db/index.js";

const ready = new WeakSet<SupportDatabase>();
function available(database: SupportDatabase): boolean {
  if(ready.has(database))return true;
  if(!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='channel_connections'").get())return false;
  ready.add(database);return true;
}

export function readChannelSource(database: SupportDatabase, conversationId: string): ChannelSource | null {
  if (!available(database)) return null;
  const row = database.prepare(`SELECT connection.id, connection.name, conversation.external_id,
    conversation.thread_id, conversation.external_url
    FROM conversations conversation JOIN channel_connections connection ON connection.id=conversation.connection_id
    WHERE conversation.id=?`).get(conversationId) as {
      id:string;name:string;external_id:string;thread_id:string|null;external_url:string|null;
    } | undefined;
  return row ? {id:row.id,name:row.name,externalConversationId:row.external_id,threadId:row.thread_id,externalUrl:row.external_url} : null;
}

export function readChannelMessageMetadata(database: SupportDatabase, messageId: string): {
  channel?:ChannelSource; externalAttachments?:ChannelAttachment[]; deletedAt?:string|null;
} {
  if(!available(database))return {};
  const row=database.prepare(`SELECT connection.id,connection.name,conversation.external_id,conversation.thread_id,conversation.external_url,
    version.attachments_json,version.deleted_at FROM channel_message_versions version
    JOIN messages message ON message.id=version.message_id
    JOIN conversations conversation ON conversation.id=message.group_id
    JOIN channel_connections connection ON connection.id=version.connection_id WHERE message.id=?`).get(messageId) as {
      id:string;name:string;external_id:string;thread_id:string|null;external_url:string|null;attachments_json:string;deleted_at:string|null;
    } | undefined;
  if(!row)return {};
  return {channel:{id:row.id,name:row.name,externalConversationId:row.external_id,threadId:row.thread_id,externalUrl:row.external_url},
    externalAttachments:JSON.parse(row.attachments_json),deletedAt:row.deleted_at};
}
