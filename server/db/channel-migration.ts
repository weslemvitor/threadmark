import type { Migration } from './schema.js';

/** Additive upgrade; keeps WhatsApp identifiers and compatibility queries intact. */
export const channelMigration: Migration = {
 version: 74, name: 'configurable_inbound_channels', disableForeignKeys: true,
 sql: `
CREATE TABLE channel_connections (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','paused')),
 client_id TEXT REFERENCES clients(id) ON DELETE RESTRICT,
 config_json TEXT NOT NULL CHECK(json_valid(config_json)),
 token_digest TEXT NOT NULL, signature_secret_ref TEXT,
 last_received_at TEXT, last_error TEXT, last_preview_at TEXT, preview_config_hash TEXT, created_by TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;
ALTER TABLE whatsapp_groups RENAME TO conversations;
PRAGMA legacy_alter_table = ON;
CREATE TABLE conversations_next (
        id TEXT PRIMARY KEY,
        account_id TEXT REFERENCES whatsapp_accounts(id) ON DELETE RESTRICT,
        client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
        external_jid TEXT UNIQUE,
        subject TEXT NOT NULL,
        monitored INTEGER NOT NULL DEFAULT 1 CHECK (monitored IN (0, 1)),
        history_oldest_at TEXT,
        history_newest_at TEXT,
        history_complete INTEGER NOT NULL DEFAULT 0 CHECK (history_complete IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      , client_link_source TEXT NOT NULL DEFAULT 'fallback'
          CHECK (client_link_source IN ('fallback', 'participant_match', 'manual')), triage_enabled_at TEXT, triage_watermark_at TEXT, suggestions_muted_at TEXT, suggestions_muted_by TEXT, connection_id TEXT REFERENCES channel_connections(id) ON DELETE RESTRICT, external_id TEXT, thread_id TEXT, external_url TEXT, conversation_scope TEXT NOT NULL DEFAULT 'group' CHECK (conversation_scope IN ('group','direct')), UNIQUE(connection_id, external_id, thread_id)) STRICT;
INSERT INTO conversations_next (id,account_id,client_id,external_jid,subject,monitored,history_oldest_at,history_newest_at,history_complete,created_at,updated_at,client_link_source,triage_enabled_at,triage_watermark_at,suggestions_muted_at,suggestions_muted_by) SELECT id,account_id,client_id,external_jid,subject,monitored,history_oldest_at,history_newest_at,history_complete,created_at,updated_at,client_link_source,triage_enabled_at,triage_watermark_at,suggestions_muted_at,suggestions_muted_by FROM conversations;
DROP TABLE conversations;
ALTER TABLE conversations_next RENAME TO conversations;
CREATE TABLE participants_next (
        id TEXT PRIMARY KEY,
        external_jid TEXT UNIQUE,
        phone_e164 TEXT,
        display_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      , connection_id TEXT REFERENCES channel_connections(id) ON DELETE RESTRICT, external_id TEXT, UNIQUE(connection_id, external_id)) STRICT;
INSERT INTO participants_next (id,external_jid,phone_e164,display_name,created_at,updated_at) SELECT id,external_jid,phone_e164,display_name,created_at,updated_at FROM participants;
DROP TABLE participants;
ALTER TABLE participants_next RENAME TO participants;
PRAGMA legacy_alter_table = OFF;
CREATE INDEX conversations_suggestions_muted_idx ON conversations(suggestions_muted_at) WHERE suggestions_muted_at IS NOT NULL;
CREATE UNIQUE INDEX conversations_channel_identity_idx ON conversations(connection_id, external_id, COALESCE(thread_id,'')) WHERE connection_id IS NOT NULL;
CREATE VIEW whatsapp_groups AS SELECT id,account_id,client_id,external_jid,subject,monitored,history_oldest_at,history_newest_at,history_complete,created_at,updated_at,client_link_source,triage_enabled_at,triage_watermark_at,suggestions_muted_at,suggestions_muted_by FROM conversations WHERE connection_id IS NULL;
CREATE TRIGGER whatsapp_groups_legacy_update INSTEAD OF UPDATE ON whatsapp_groups BEGIN
 UPDATE conversations SET account_id=NEW.account_id,client_id=NEW.client_id,external_jid=NEW.external_jid,subject=NEW.subject,monitored=NEW.monitored,history_oldest_at=NEW.history_oldest_at,history_newest_at=NEW.history_newest_at,history_complete=NEW.history_complete,created_at=NEW.created_at,updated_at=NEW.updated_at,client_link_source=NEW.client_link_source,triage_enabled_at=NEW.triage_enabled_at,triage_watermark_at=NEW.triage_watermark_at,suggestions_muted_at=NEW.suggestions_muted_at,suggestions_muted_by=NEW.suggestions_muted_by WHERE id=OLD.id AND connection_id IS NULL;
END;
CREATE TRIGGER whatsapp_groups_legacy_insert INSTEAD OF INSERT ON whatsapp_groups BEGIN
 INSERT INTO conversations (id,account_id,client_id,external_jid,subject,monitored,history_oldest_at,history_newest_at,history_complete,created_at,updated_at,client_link_source,triage_enabled_at,triage_watermark_at,suggestions_muted_at,suggestions_muted_by) VALUES (NEW.id,NEW.account_id,NEW.client_id,NEW.external_jid,NEW.subject,COALESCE(NEW.monitored,1),NEW.history_oldest_at,NEW.history_newest_at,COALESCE(NEW.history_complete,0),NEW.created_at,NEW.updated_at,COALESCE(NEW.client_link_source,'fallback'),NEW.triage_enabled_at,NEW.triage_watermark_at,NEW.suggestions_muted_at,NEW.suggestions_muted_by);
END;
CREATE TRIGGER whatsapp_groups_legacy_delete INSTEAD OF DELETE ON whatsapp_groups BEGIN
 DELETE FROM conversations WHERE id=OLD.id AND connection_id IS NULL;
END;
CREATE TABLE channel_events (
 id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES channel_connections(id) ON DELETE RESTRICT,
 external_event_id TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 config_json TEXT NOT NULL CHECK(json_valid(config_json)),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processing','processed','failed')),
 attempts INTEGER NOT NULL DEFAULT 0, error_code TEXT,
 received_at TEXT NOT NULL, processed_at TEXT,
 UNIQUE(connection_id,external_event_id)
) STRICT;
CREATE INDEX channel_events_pending_idx ON channel_events(state, received_at);
CREATE TABLE channel_message_versions (
 message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
 connection_id TEXT NOT NULL REFERENCES channel_connections(id) ON DELETE RESTRICT,
 external_message_id TEXT NOT NULL, revision_at TEXT NOT NULL,
 deleted_at TEXT, attachments_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(attachments_json))
) STRICT;
CREATE TABLE channel_message_audit (
 id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES channel_events(id) ON DELETE RESTRICT,
 message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
 event_type TEXT NOT NULL, previous_text TEXT, occurred_at TEXT NOT NULL
) STRICT;
ALTER TABLE ticket_external_messages ADD COLUMN migrated_message_id TEXT REFERENCES messages(id) ON DELETE RESTRICT;
CREATE TEMP VIEW channel_legacy_imports AS
 SELECT imported.*,
  'legacy:connection:' || MIN(imported.id) OVER (PARTITION BY imported.ticket_id, imported.source_type) AS connection_key,
  'legacy:conversation:' || MIN(imported.id) OVER (PARTITION BY imported.ticket_id, imported.source_type, imported.source_conversation_id) AS conversation_key,
  'legacy:author:' || imported.id AS author_key,
  imported.id AS message_key
 FROM ticket_external_messages imported;
INSERT INTO channel_connections (id,name,description,status,client_id,config_json,token_digest,last_error,created_by,created_at,updated_at)
 SELECT legacy.connection_key,'Importação anterior #' || ticket.number,
  'Histórico preservado; configure o recebimento antes de ativar.','paused',ticket.client_id,
  '{"format":"standard","mapping":{},"timestampFormat":"iso","roleMapping":{},"eventTypeMapping":{},"authentication":"bearer","signatureHeader":"X-Channel-Signature","signatureEncoding":"hex","conversationScope":"group","monitored":false}',lower(hex(randomblob(32))),'legacy_configuration_review_required','migration',MIN(legacy.created_at),MIN(legacy.created_at)
 FROM channel_legacy_imports legacy JOIN tickets ticket ON ticket.id=legacy.ticket_id
 GROUP BY legacy.connection_key;
INSERT INTO conversations (id,client_id,connection_id,external_id,subject,monitored,created_at,updated_at)
 SELECT legacy.conversation_key,ticket.client_id,legacy.connection_key,legacy.source_conversation_id,
  ticket.title,0,MIN(legacy.created_at),MAX(legacy.created_at)
 FROM channel_legacy_imports legacy JOIN tickets ticket ON ticket.id=legacy.ticket_id
 GROUP BY legacy.conversation_key;
INSERT INTO participants (id,connection_id,external_id,display_name,created_at,updated_at)
 SELECT author_key,connection_key,id,author_name,created_at,created_at FROM channel_legacy_imports;
INSERT INTO staff_members (participant_id,display_name,active,created_at,updated_at)
 SELECT author_key,author_name,1,created_at,created_at FROM channel_legacy_imports WHERE author_role='support';
INSERT INTO group_participants (group_id,participant_id,role,first_seen_at,last_seen_at)
 SELECT conversation_key,author_key,'member',occurred_at,occurred_at FROM channel_legacy_imports;
INSERT INTO messages (id,external_id,provider_message_id,group_id,sender_id,occurred_at,ingested_at,text,message_type,triage_kind,triage_state,created_at,updated_at)
 SELECT message_key,external_message_id,external_message_id,conversation_key,author_key,occurred_at,created_at,body,'text',
  CASE WHEN author_role='support' THEN 'context' ELSE 'demand' END,'ticketed',created_at,created_at FROM channel_legacy_imports;
INSERT INTO channel_message_versions (message_id,connection_id,external_message_id,revision_at)
 SELECT message_key,connection_key,external_message_id,occurred_at FROM channel_legacy_imports;
INSERT INTO ticket_messages (ticket_id,message_id,added_at)
 SELECT ticket_id,message_key,created_at FROM channel_legacy_imports;
UPDATE ticket_external_messages SET migrated_message_id=id;
DROP VIEW channel_legacy_imports;
UPDATE connected_apps SET provider_type='custom_http', config_json=json_set(config_json,'$.legacyReviewRequired',json('true')), enabled=0, last_test_status=NULL, last_test_message='Revise a configuração HTTP genérica antes de reativar.' WHERE provider_type='intercom';
`,
};
