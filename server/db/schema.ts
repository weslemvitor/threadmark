export interface Migration {
  version: number;
  name: string;
  sql: string;
  disableForeignKeys?: boolean;
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: "initial_support_schema",
    sql: `
      CREATE TABLE IF NOT EXISTS whatsapp_accounts (
        id TEXT PRIMARY KEY,
        phone_number TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS clients (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK (kind IN ('agency', 'ecommerce')),
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS client_stores (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        business_id TEXT,
        platform TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(client_id, name),
        UNIQUE(client_id, business_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS whatsapp_groups (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE RESTRICT,
        client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
        external_jid TEXT NOT NULL UNIQUE,
        subject TEXT NOT NULL,
        monitored INTEGER NOT NULL DEFAULT 1 CHECK (monitored IN (0, 1)),
        history_oldest_at TEXT,
        history_newest_at TEXT,
        history_complete INTEGER NOT NULL DEFAULT 0 CHECK (history_complete IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS participants (
        id TEXT PRIMARY KEY,
        external_jid TEXT NOT NULL UNIQUE,
        phone_e164 TEXT,
        display_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS group_participants (
        group_id TEXT NOT NULL REFERENCES whatsapp_groups(id) ON DELETE CASCADE,
        participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin', 'owner')),
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY (group_id, participant_id)
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS staff_members (
        participant_id TEXT PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
        display_name TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        external_id TEXT NOT NULL,
        group_id TEXT NOT NULL REFERENCES whatsapp_groups(id) ON DELETE RESTRICT,
        sender_id TEXT NOT NULL REFERENCES participants(id) ON DELETE RESTRICT,
        occurred_at TEXT NOT NULL,
        ingested_at TEXT NOT NULL,
        text TEXT,
        message_type TEXT NOT NULL,
        quoted_external_id TEXT,
        triage_kind TEXT NOT NULL DEFAULT 'unclassified'
          CHECK (triage_kind IN ('unclassified', 'demand', 'uncertain', 'continuation', 'information', 'social', 'context')),
        triage_state TEXT NOT NULL DEFAULT 'unreviewed'
          CHECK (triage_state IN ('unreviewed', 'ticketed', 'ignored', 'context')),
        raw_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(group_id, external_id)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS messages_group_occurred_idx
        ON messages(group_id, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS messages_triage_idx
        ON messages(triage_state, triage_kind, occurred_at DESC);

      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('image', 'pdf', 'document', 'video', 'other')),
        mime_type TEXT NOT NULL,
        file_name TEXT,
        local_path TEXT NOT NULL,
        size_bytes INTEGER,
        sha256 TEXT NOT NULL,
        source_key TEXT UNIQUE,
        extracted_text TEXT,
        available INTEGER NOT NULL DEFAULT 1 CHECK (available IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(message_id, sha256)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS tickets (
        number INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
        group_id TEXT NOT NULL REFERENCES whatsapp_groups(id) ON DELETE RESTRICT,
        affected_store_id TEXT REFERENCES client_stores(id) ON DELETE SET NULL,
        source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'new'
          CHECK (status IN ('new', 'triage', 'in_progress', 'waiting_customer', 'blocked', 'resolved', 'cancelled', 'archived')),
        priority TEXT NOT NULL DEFAULT 'normal'
          CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
        confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
        needs_review INTEGER NOT NULL DEFAULT 1 CHECK (needs_review IN (0, 1)),
        ai_relation TEXT
          CHECK (ai_relation IS NULL OR ai_relation IN ('new', 'continuation', 'possible_reopen', 'informational', 'social', 'uncertain')),
        next_action TEXT,
        first_message_at TEXT NOT NULL,
        last_message_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resolved_at TEXT,
        archived_at TEXT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS tickets_status_updated_idx
        ON tickets(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS tickets_client_updated_idx
        ON tickets(client_id, updated_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS tickets_source_message_idx
        ON tickets(source_message_id)
        WHERE source_message_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS ticket_messages (
        ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
        added_at TEXT NOT NULL,
        PRIMARY KEY (ticket_id, message_id)
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS ticket_events (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        actor TEXT NOT NULL,
        from_status TEXT,
        to_status TEXT,
        data_json TEXT NOT NULL DEFAULT '{}',
        occurred_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS ticket_events_ticket_time_idx
        ON ticket_events(ticket_id, occurred_at);

      CREATE TABLE IF NOT EXISTS categories (
        id TEXT PRIMARY KEY,
        facet TEXT NOT NULL
          CHECK (facet IN ('reason', 'product', 'platform', 'symptom', 'root_cause', 'resolution')),
        slug TEXT NOT NULL,
        label TEXT NOT NULL,
        color TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(facet, slug)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS ticket_categories (
        ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
        source TEXT NOT NULL DEFAULT 'ai' CHECK (source IN ('ai', 'manual', 'rule')),
        confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
        added_at TEXT NOT NULL,
        PRIMARY KEY (ticket_id, category_id)
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS suggestions (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
        evidence_json TEXT NOT NULL DEFAULT '[]',
        missing_information_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'candidate'
          CHECK (status IN ('candidate', 'accepted', 'rejected', 'superseded')),
        model TEXT,
        prompt_version TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS suggestions_ticket_time_idx
        ON suggestions(ticket_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS sent_responses (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        body TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        UNIQUE(ticket_id, message_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS resolutions (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL UNIQUE REFERENCES tickets(id) ON DELETE CASCADE,
        summary TEXT NOT NULL,
        root_cause TEXT,
        outcome TEXT,
        validated_by TEXT NOT NULL,
        validated_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS knowledge_candidates (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('faq', 'problem', 'client_history')),
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'candidate'
          CHECK (status IN ('candidate', 'approved', 'rejected', 'published')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS evidence_queries (
        id TEXT PRIMARY KEY,
        ticket_id TEXT REFERENCES tickets(id) ON DELETE SET NULL,
        source TEXT NOT NULL CHECK (source IN ('sqlite', 'postgres', 'clickhouse', 'aws', 'code', 'obsidian')),
        operation TEXT NOT NULL,
        parameters_json TEXT NOT NULL DEFAULT '{}',
        result_summary TEXT,
        success INTEGER NOT NULL CHECK (success IN (0, 1)),
        duration_ms INTEGER,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS sync_runs (
        id TEXT PRIMARY KEY,
        account_id TEXT REFERENCES whatsapp_accounts(id) ON DELETE SET NULL,
        state TEXT NOT NULL CHECK (state IN ('running', 'completed', 'partial', 'failed')),
        started_at TEXT NOT NULL,
        finished_at TEXT,
        groups_seen INTEGER NOT NULL DEFAULT 0,
        messages_seen INTEGER NOT NULL DEFAULT 0,
        messages_inserted INTEGER NOT NULL DEFAULT 0,
        attachments_saved INTEGER NOT NULL DEFAULT 0,
        error TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS runtime_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        state TEXT NOT NULL CHECK (state IN ('offline', 'starting', 'syncing', 'online', 'stopping', 'error')),
        started_at TEXT,
        last_heartbeat_at TEXT,
        last_sync_at TEXT,
        connected_account TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS investigation_jobs (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'failed')),
        instructions TEXT,
        requested_at TEXT NOT NULL,
        started_at TEXT,
        claimed_at TEXT,
        lease_expires_at TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        finished_at TEXT,
        result_json TEXT,
        error TEXT
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS investigation_jobs_ticket_active_idx
        ON investigation_jobs(ticket_id)
        WHERE state IN ('queued', 'running');
    `,
  },
  {
    version: 2,
    name: "provider_message_identity",
    sql: `
      ALTER TABLE messages ADD COLUMN provider_message_id TEXT;
      CREATE INDEX IF NOT EXISTS messages_group_provider_idx
        ON messages(group_id, provider_message_id);
    `,
  },
  {
    version: 3,
    name: "knowledge_candidate_deduplication",
    sql: `
      CREATE UNIQUE INDEX IF NOT EXISTS knowledge_candidates_ticket_kind_idx
        ON knowledge_candidates(ticket_id, kind);
    `,
  },
  {
    version: 4,
    name: "manual_client_profiles_and_store_archiving",
    sql: `
      ALTER TABLE clients
        ADD COLUMN manual_override INTEGER NOT NULL DEFAULT 0
          CHECK (manual_override IN (0, 1));
      ALTER TABLE client_stores
        ADD COLUMN active INTEGER NOT NULL DEFAULT 1
          CHECK (active IN (0, 1));
      CREATE INDEX IF NOT EXISTS client_stores_client_active_idx
        ON client_stores(client_id, active, name);
    `,
  },
  {
    version: 5,
    name: "conversational_investigation_threads",
    sql: `
      CREATE TABLE IF NOT EXISTS investigation_threads (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL UNIQUE REFERENCES tickets(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'concluded')),
        summary TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS investigation_thread_messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES investigation_threads(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('operator', 'assistant')),
        body TEXT NOT NULL,
        phase TEXT
          CHECK (phase IS NULL OR phase IN ('analysis', 'needs_information', 'conclusion')),
        evidence_json TEXT NOT NULL DEFAULT '[]',
        suggested_response TEXT,
        next_action TEXT,
        client_message_id TEXT,
        job_id TEXT UNIQUE,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS investigation_thread_messages_time_idx
        ON investigation_thread_messages(thread_id, created_at, id);
      CREATE UNIQUE INDEX IF NOT EXISTS investigation_thread_messages_client_id_idx
        ON investigation_thread_messages(thread_id, client_message_id)
        WHERE client_message_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS investigation_thread_jobs (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES investigation_threads(id) ON DELETE CASCADE,
        operator_message_id TEXT NOT NULL
          REFERENCES investigation_thread_messages(id) ON DELETE RESTRICT,
        assistant_message_id TEXT
          REFERENCES investigation_thread_messages(id) ON DELETE SET NULL,
        state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'failed')),
        requested_at TEXT NOT NULL,
        started_at TEXT,
        claimed_at TEXT,
        lease_expires_at TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        finished_at TEXT,
        result_json TEXT,
        error TEXT,
        UNIQUE(thread_id, operator_message_id)
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS investigation_thread_jobs_active_idx
        ON investigation_thread_jobs(thread_id)
        WHERE state IN ('queued', 'running');
      CREATE INDEX IF NOT EXISTS investigation_thread_jobs_queue_idx
        ON investigation_thread_jobs(state, requested_at);
    `,
  },
  {
    version: 6,
    name: "lossless_automatic_investigation_reruns",
    sql: `
      ALTER TABLE investigation_jobs
        ADD COLUMN rerun_requested INTEGER NOT NULL DEFAULT 0
          CHECK (rerun_requested IN (0, 1));
      ALTER TABLE investigation_jobs
        ADD COLUMN rerun_instructions TEXT;

      UPDATE evidence_queries
      SET success = 0,
          operation = CASE operation
            WHEN 'codex_readonly_investigation' THEN 'codex_claim_unverified'
            WHEN 'codex_conversational_investigation' THEN 'codex_conversational_claim_unverified'
            ELSE operation
          END
      WHERE operation IN (
        'codex_readonly_investigation',
        'codex_conversational_investigation'
      );
    `,
  },
  {
    version: 7,
    name: "private_contact_triage_and_client_ignoring",
    sql: `
      ALTER TABLE clients
        ADD COLUMN identification_pending INTEGER NOT NULL DEFAULT 0
          CHECK (identification_pending IN (0, 1));
      ALTER TABLE clients ADD COLUMN ignored_at TEXT;
      ALTER TABLE clients ADD COLUMN ignored_by TEXT;
      ALTER TABLE clients ADD COLUMN ignore_reason TEXT;

      ALTER TABLE messages
        ADD COLUMN ingestion_source TEXT NOT NULL DEFAULT 'legacy'
          CHECK (ingestion_source IN ('legacy', 'history', 'realtime_append', 'realtime_notify'));

      CREATE INDEX IF NOT EXISTS clients_operational_idx
        ON clients(ignored_at, identification_pending, name);
      CREATE INDEX IF NOT EXISTS messages_ingestion_source_idx
        ON messages(ingestion_source, triage_state, occurred_at DESC);
    `,
  },
  {
    version: 8,
    name: "whatsapp_group_rosters_and_identity_links",
    sql: `
      CREATE TABLE IF NOT EXISTS whatsapp_identity_links (
        phone_jid TEXT NOT NULL,
        lid_jid TEXT NOT NULL,
        source TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY (phone_jid, lid_jid),
        UNIQUE (phone_jid),
        UNIQUE (lid_jid)
      ) WITHOUT ROWID;

      ALTER TABLE group_participants
        ADD COLUMN active INTEGER NOT NULL DEFAULT 1
          CHECK (active IN (0, 1));
      ALTER TABLE group_participants
        ADD COLUMN source TEXT NOT NULL DEFAULT 'message';
      ALTER TABLE group_participants ADD COLUMN last_confirmed_at TEXT;

      ALTER TABLE whatsapp_groups
        ADD COLUMN client_link_source TEXT NOT NULL DEFAULT 'fallback'
          CHECK (client_link_source IN ('fallback', 'participant_match', 'manual'));

      UPDATE whatsapp_groups
      SET client_link_source = 'manual'
      WHERE (external_jid LIKE '%@s.whatsapp.net' OR external_jid LIKE '%@lid')
        AND EXISTS (
          SELECT 1
          FROM clients c
          WHERE c.id = whatsapp_groups.client_id
            AND c.manual_override = 1
            AND c.identification_pending = 0
        );

      CREATE INDEX IF NOT EXISTS group_participants_active_participant_idx
        ON group_participants(participant_id, active, group_id);
      CREATE INDEX IF NOT EXISTS whatsapp_identity_links_lid_idx
        ON whatsapp_identity_links(lid_jid);
    `,
  },
  {
    version: 9,
    name: "standalone_knowledge_bases_and_audit",
    sql: `
      DROP INDEX IF EXISTS knowledge_candidates_ticket_kind_idx;
      ALTER TABLE knowledge_candidates RENAME TO knowledge_candidates_v8;

      CREATE TABLE knowledge_candidates (
        id TEXT PRIMARY KEY,
        ticket_id TEXT REFERENCES tickets(id) ON DELETE CASCADE,
        client_id TEXT REFERENCES clients(id) ON DELETE CASCADE,
        store_id TEXT REFERENCES client_stores(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('faq', 'problem', 'client_history')),
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'candidate'
          CHECK (status IN ('candidate', 'approved', 'rejected', 'published', 'archived')),
        source TEXT NOT NULL
          CHECK (source IN ('ticket', 'manual', 'import')),
        created_by TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        status_changed_at TEXT NOT NULL,
        status_changed_by TEXT NOT NULL,
        archived_at TEXT,
        import_fingerprint TEXT UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (ticket_id IS NOT NULL OR source IN ('manual', 'import'))
      ) STRICT;

      INSERT INTO knowledge_candidates
        (id, ticket_id, client_id, store_id, kind, title, content, status, source,
         created_by, updated_by, status_changed_at, status_changed_by,
         archived_at, import_fingerprint, created_at, updated_at)
      SELECT
        legacy.id,
        legacy.ticket_id,
        ticket.client_id,
        ticket.affected_store_id,
        legacy.kind,
        legacy.title,
        legacy.content,
        legacy.status,
        'ticket',
        'Sistema',
        'Sistema',
        legacy.updated_at,
        'Sistema',
        NULL,
        NULL,
        legacy.created_at,
        legacy.updated_at
      FROM knowledge_candidates_v8 legacy
      JOIN tickets ticket ON ticket.id = legacy.ticket_id;

      DROP TABLE knowledge_candidates_v8;

      CREATE UNIQUE INDEX knowledge_candidates_ticket_kind_idx
        ON knowledge_candidates(ticket_id, kind);
      CREATE INDEX knowledge_candidates_client_status_idx
        ON knowledge_candidates(client_id, status, updated_at DESC);
      CREATE INDEX knowledge_candidates_status_updated_idx
        ON knowledge_candidates(status, updated_at DESC);

      CREATE TABLE knowledge_candidate_events (
        id TEXT PRIMARY KEY,
        knowledge_candidate_id TEXT NOT NULL
          REFERENCES knowledge_candidates(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL
          CHECK (event_type IN ('created', 'imported', 'updated', 'status_changed')),
        actor TEXT NOT NULL,
        from_status TEXT
          CHECK (from_status IS NULL OR from_status IN ('candidate', 'approved', 'rejected', 'published', 'archived')),
        to_status TEXT
          CHECK (to_status IS NULL OR to_status IN ('candidate', 'approved', 'rejected', 'published', 'archived')),
        reason TEXT,
        data_json TEXT NOT NULL DEFAULT '{}',
        occurred_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX knowledge_candidate_events_candidate_time_idx
        ON knowledge_candidate_events(knowledge_candidate_id, occurred_at, id);

      INSERT INTO knowledge_candidate_events
        (id, knowledge_candidate_id, event_type, actor, from_status, to_status,
         reason, data_json, occurred_at)
      SELECT
        lower(hex(randomblob(16))),
        id,
        'created',
        'Sistema',
        NULL,
        status,
        NULL,
        '{"migrated":true}',
        created_at
      FROM knowledge_candidates;
    `,
  },
  {
    version: 10,
    name: "conversation_first_triage",
    sql: `
      ALTER TABLE whatsapp_groups ADD COLUMN triage_enabled_at TEXT;
      ALTER TABLE whatsapp_groups ADD COLUMN triage_watermark_at TEXT;

      UPDATE whatsapp_groups
      SET triage_enabled_at = COALESCE(
            (SELECT MAX(message.occurred_at)
             FROM messages message
             WHERE message.group_id = whatsapp_groups.id),
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          ),
          triage_watermark_at = COALESCE(
            (SELECT MAX(message.occurred_at)
             FROM messages message
             WHERE message.group_id = whatsapp_groups.id),
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          );

      ALTER TABLE tickets
        ADD COLUMN merged_into_ticket_id TEXT REFERENCES tickets(id) ON DELETE SET NULL;
      CREATE INDEX tickets_merged_into_idx
        ON tickets(merged_into_ticket_id)
        WHERE merged_into_ticket_id IS NOT NULL;
      CREATE INDEX ticket_messages_message_idx
        ON ticket_messages(message_id, ticket_id);
      CREATE INDEX tickets_group_status_idx
        ON tickets(group_id, status, last_message_at DESC);
      CREATE INDEX messages_group_occurred_id_idx
        ON messages(group_id, occurred_at DESC, id DESC);
      CREATE INDEX messages_group_triage_occurred_idx
        ON messages(group_id, triage_state, occurred_at DESC, id DESC);

      CREATE TABLE triage_blocks (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL REFERENCES whatsapp_groups(id) ON DELETE CASCADE,
        sender_id TEXT REFERENCES participants(id) ON DELETE SET NULL,
        state TEXT NOT NULL DEFAULT 'pending'
          CHECK (state IN (
            'pending', 'ticketed', 'attached', 'ignored', 'context',
            'restored', 'superseded'
          )),
        triage_kind TEXT NOT NULL DEFAULT 'unclassified'
          CHECK (triage_kind IN (
            'unclassified', 'demand', 'uncertain', 'continuation',
            'information', 'social', 'context'
          )),
        suggested_action TEXT
          CHECK (suggested_action IS NULL OR suggested_action IN ('create', 'attach', 'ignore')),
        suggested_ticket_id TEXT REFERENCES tickets(id) ON DELETE SET NULL,
        confirmed_ticket_id TEXT REFERENCES tickets(id) ON DELETE SET NULL,
        affected_store_id TEXT REFERENCES client_stores(id) ON DELETE SET NULL,
        title TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '',
        confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
        reason TEXT,
        origin TEXT NOT NULL DEFAULT 'suggestion'
          CHECK (origin IN ('suggestion', 'operator', 'system')),
        created_by TEXT NOT NULL,
        request_key TEXT UNIQUE,
        first_message_at TEXT NOT NULL,
        last_message_at TEXT NOT NULL,
        resolved_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX triage_blocks_group_pending_idx
        ON triage_blocks(group_id, state, last_message_at DESC);
      CREATE INDEX triage_blocks_sender_pending_idx
        ON triage_blocks(group_id, sender_id, state, last_message_at DESC);
      CREATE INDEX triage_blocks_group_state_first_idx
        ON triage_blocks(group_id, state, first_message_at, id);

      CREATE TABLE triage_block_messages (
        block_id TEXT NOT NULL REFERENCES triage_blocks(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        added_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (block_id, message_id)
      ) WITHOUT ROWID;
      CREATE UNIQUE INDEX triage_block_messages_active_message_idx
        ON triage_block_messages(message_id)
        WHERE active = 1;
      CREATE INDEX triage_block_messages_block_active_idx
        ON triage_block_messages(block_id, active, message_id);

      CREATE TABLE triage_block_events (
        id TEXT PRIMARY KEY,
        block_id TEXT NOT NULL REFERENCES triage_blocks(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        actor TEXT NOT NULL,
        message_ids_json TEXT NOT NULL DEFAULT '[]',
        data_json TEXT NOT NULL DEFAULT '{}',
        occurred_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX triage_block_events_block_time_idx
        ON triage_block_events(block_id, occurred_at, id);
    `,
  },
  {
    version: 11,
    name: "conversation_ticket_suggestion_mute",
    sql: `
      ALTER TABLE whatsapp_groups ADD COLUMN suggestions_muted_at TEXT;
      ALTER TABLE whatsapp_groups ADD COLUMN suggestions_muted_by TEXT;

      CREATE INDEX whatsapp_groups_suggestions_muted_idx
        ON whatsapp_groups(suggestions_muted_at)
        WHERE suggestions_muted_at IS NOT NULL;
    `,
  },
  {
    version: 12,
    name: "message_reactions_and_chat_control_events",
    sql: `
      CREATE TABLE message_reaction_events (
        id TEXT PRIMARY KEY,
        event_external_id TEXT NOT NULL UNIQUE,
        group_id TEXT NOT NULL REFERENCES whatsapp_groups(id) ON DELETE CASCADE,
        target_provider_message_id TEXT NOT NULL,
        reactor_id TEXT NOT NULL REFERENCES participants(id) ON DELETE RESTRICT,
        emoji TEXT,
        occurred_at TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        raw_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX message_reaction_events_target_idx
        ON message_reaction_events(
          group_id, target_provider_message_id, reactor_id,
          occurred_at DESC, observed_at DESC
        );

      INSERT OR IGNORE INTO message_reaction_events (
        id, event_external_id, group_id, target_provider_message_id,
        reactor_id, emoji, occurred_at, observed_at, raw_json,
        created_at, updated_at
      )
      SELECT
        message.id,
        message.external_id,
        message.group_id,
        json_extract(message.raw_json, '$.message.reactionMessage.key.id'),
        message.sender_id,
        NULLIF(trim(COALESCE(
          json_extract(message.raw_json, '$.message.reactionMessage.text'),
          message.text,
          ''
        )), ''),
        message.occurred_at,
        message.ingested_at,
        message.raw_json,
        message.created_at,
        message.updated_at
      FROM messages message
      WHERE message.message_type = 'reactionMessage'
        AND json_valid(message.raw_json)
        AND NULLIF(
          json_extract(message.raw_json, '$.message.reactionMessage.key.id'),
          ''
        ) IS NOT NULL;

      UPDATE triage_block_messages
      SET active = 0,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE active = 1
        AND message_id IN (
          SELECT message.id
          FROM messages message
          WHERE message.triage_state != 'ticketed'
            AND (
              message.message_type = 'reactionMessage'
              OR (
                message.message_type = 'protocolMessage'
                AND json_valid(message.raw_json)
                AND json_extract(
                  message.raw_json,
                  '$.message.protocolMessage.type'
                ) = 0
              )
            )
        );

      UPDATE triage_blocks
      SET state = 'context',
          resolved_at = COALESCE(
            resolved_at,
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          ),
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE state = 'pending'
        AND NOT EXISTS (
          SELECT 1
          FROM triage_block_messages block_message
          WHERE block_message.block_id = triage_blocks.id
            AND block_message.active = 1
        );

      UPDATE messages
      SET triage_kind = 'context',
          triage_state = 'context',
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE triage_state != 'ticketed'
        AND (
          message_type = 'reactionMessage'
          OR (
            message_type = 'protocolMessage'
            AND json_valid(raw_json)
            AND json_extract(raw_json, '$.message.protocolMessage.type') = 0
          )
      );
    `,
  },
  {
    version: 13,
    name: "detach_chat_controls_from_support_workflow",
    sql: `
      CREATE TEMP TABLE migration_13_control_only_tickets (
        id TEXT PRIMARY KEY
      ) WITHOUT ROWID;

      INSERT INTO migration_13_control_only_tickets (id)
      SELECT ticket.id
      FROM tickets ticket
      WHERE ticket.status != 'archived'
        AND (
          EXISTS (
            SELECT 1
            FROM ticket_messages ticket_message
            JOIN messages message ON message.id = ticket_message.message_id
            WHERE ticket_message.ticket_id = ticket.id
              AND message.message_type IN ('reactionMessage', 'protocolMessage')
          )
          OR EXISTS (
            SELECT 1
            FROM messages source
            WHERE source.id = ticket.source_message_id
              AND source.message_type IN ('reactionMessage', 'protocolMessage')
          )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM ticket_messages ticket_message
          JOIN messages message ON message.id = ticket_message.message_id
          WHERE ticket_message.ticket_id = ticket.id
            AND message.message_type NOT IN ('reactionMessage', 'protocolMessage')
        );

      DELETE FROM tickets
      WHERE id IN (SELECT id FROM migration_13_control_only_tickets);

      DELETE FROM ticket_messages
      WHERE message_id IN (
        SELECT id
        FROM messages
        WHERE message_type IN ('reactionMessage', 'protocolMessage')
      );

      UPDATE tickets
      SET source_message_id = NULL,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE source_message_id IN (
        SELECT id
        FROM messages
        WHERE message_type IN ('reactionMessage', 'protocolMessage')
      );

      UPDATE tickets
      SET first_message_at = COALESCE(
            (
              SELECT MIN(message.occurred_at)
              FROM ticket_messages ticket_message
              JOIN messages message ON message.id = ticket_message.message_id
              WHERE ticket_message.ticket_id = tickets.id
            ),
            first_message_at
          ),
          last_message_at = COALESCE(
            (
              SELECT MAX(message.occurred_at)
              FROM ticket_messages ticket_message
              JOIN messages message ON message.id = ticket_message.message_id
              WHERE ticket_message.ticket_id = tickets.id
            ),
            last_message_at
          ),
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE EXISTS (
        SELECT 1
        FROM ticket_messages ticket_message
        WHERE ticket_message.ticket_id = tickets.id
      );

      UPDATE triage_block_messages
      SET active = 0,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE active = 1
        AND message_id IN (
          SELECT id
          FROM messages
          WHERE message_type IN ('reactionMessage', 'protocolMessage')
        );

      UPDATE triage_blocks
      SET state = 'context',
          resolved_at = COALESCE(
            resolved_at,
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          ),
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE state = 'pending'
        AND NOT EXISTS (
          SELECT 1
          FROM triage_block_messages block_message
          WHERE block_message.block_id = triage_blocks.id
            AND block_message.active = 1
        );

      UPDATE messages
      SET triage_kind = 'context',
          triage_state = 'context',
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE message_type IN ('reactionMessage', 'protocolMessage');

      DROP TABLE migration_13_control_only_tickets;
    `,
  },
  {
    version: 14,
    name: "normalize_private_conversation_placeholder_subjects",
    sql: `
      UPDATE whatsapp_groups
      SET subject = substr(external_jid, 1, instr(external_jid, '@') - 1),
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE (
          external_jid LIKE '%@s.whatsapp.net'
          OR external_jid LIKE '%@lid'
        )
        AND instr(external_jid, '@') > 1
        AND lower(trim(subject)) IN (
          lower(
            'Grupo ' || substr(external_jid, 1, instr(external_jid, '@') - 1)
          ),
          lower(
            'Conversa privada ' || substr(
              external_jid,
              1,
              instr(external_jid, '@') - 1
            )
          )
        );
    `,
  },
  {
    version: 15,
    name: "backfill_whatsapp_rich_message_text",
    sql: `
      UPDATE messages
      SET text = NULLIF(TRIM(COALESCE(
            json_extract(raw_json,
              '$.message.templateMessage.hydratedFourRowTemplate.hydratedContentText'),
            json_extract(raw_json,
              '$.message.templateMessage.hydratedTemplate.hydratedContentText'),
            json_extract(raw_json,
              '$.message.templateMessage.interactiveMessageTemplate.body.text'),
            json_extract(raw_json,
              '$.message.templateMessage.interactiveMessageTemplate.header.imageMessage.caption'),
            json_extract(raw_json, '$.message.buttonsMessage.contentText'),
            json_extract(raw_json, '$.message.interactiveMessage.body.text'),
            json_extract(raw_json, '$.message.groupInviteMessage.caption'),
            json_extract(raw_json, '$.message.groupInviteMessage.groupName'),
            ''
          )), ''),
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE TRIM(COALESCE(text, '')) = ''
        AND raw_json IS NOT NULL
        AND json_valid(raw_json)
        AND NULLIF(TRIM(COALESCE(
              json_extract(raw_json,
                '$.message.templateMessage.hydratedFourRowTemplate.hydratedContentText'),
              json_extract(raw_json,
                '$.message.templateMessage.hydratedTemplate.hydratedContentText'),
              json_extract(raw_json,
                '$.message.templateMessage.interactiveMessageTemplate.body.text'),
              json_extract(raw_json,
                '$.message.templateMessage.interactiveMessageTemplate.header.imageMessage.caption'),
              json_extract(raw_json, '$.message.buttonsMessage.contentText'),
              json_extract(raw_json, '$.message.interactiveMessage.body.text'),
              json_extract(raw_json, '$.message.groupInviteMessage.caption'),
              json_extract(raw_json, '$.message.groupInviteMessage.groupName'),
              ''
            )), '') IS NOT NULL;
    `,
  },
  {
    version: 16,
    name: "persistent_ai_conversation_triage",
    sql: `
      CREATE TABLE triage_ai_settings (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        model TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE triage_ai_jobs (
        id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL UNIQUE,
        group_id TEXT NOT NULL REFERENCES whatsapp_groups(id) ON DELETE CASCADE,
        state TEXT NOT NULL DEFAULT 'queued'
          CHECK (state IN ('queued', 'running', 'completed', 'failed')),
        model TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        input_json TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        fallback_used INTEGER NOT NULL DEFAULT 0 CHECK (fallback_used IN (0, 1)),
        requested_at TEXT NOT NULL,
        started_at TEXT,
        claimed_at TEXT,
        lease_expires_at TEXT,
        finished_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX triage_ai_jobs_state_requested_idx
        ON triage_ai_jobs(state, requested_at, id);
      CREATE INDEX triage_ai_jobs_group_time_idx
        ON triage_ai_jobs(group_id, requested_at DESC);

      CREATE TABLE triage_ai_job_messages (
        job_id TEXT NOT NULL REFERENCES triage_ai_jobs(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
        position INTEGER NOT NULL CHECK (position >= 0),
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (job_id, message_id)
      ) WITHOUT ROWID;
      CREATE UNIQUE INDEX triage_ai_job_messages_active_message_idx
        ON triage_ai_job_messages(message_id)
        WHERE active = 1;
      CREATE INDEX triage_ai_job_messages_job_position_idx
        ON triage_ai_job_messages(job_id, position, message_id);

      ALTER TABLE triage_blocks ADD COLUMN proposed_categories_json TEXT;
      ALTER TABLE triage_blocks ADD COLUMN ai_model TEXT;
      ALTER TABLE triage_blocks ADD COLUMN ai_prompt_version TEXT;
      ALTER TABLE triage_blocks
        ADD COLUMN triage_ai_job_id TEXT REFERENCES triage_ai_jobs(id) ON DELETE SET NULL;
      ALTER TABLE triage_blocks
        ADD COLUMN ai_fallback_used INTEGER NOT NULL DEFAULT 0
          CHECK (ai_fallback_used IN (0, 1));
      CREATE INDEX triage_blocks_ai_job_idx
        ON triage_blocks(triage_ai_job_id)
        WHERE triage_ai_job_id IS NOT NULL;
    `,
  },
  {
    version: 17,
    name: "local_application_authentication",
    sql: `
      CREATE TABLE local_app_settings (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        organization_name TEXT NOT NULL,
        workspace_name TEXT NOT NULL,
        timezone TEXT NOT NULL,
        setup_completed_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE local_users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL
          CHECK (role IN ('owner', 'admin', 'operator', 'viewer')),
        password_hash TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        failed_login_attempts INTEGER NOT NULL DEFAULT 0
          CHECK (failed_login_attempts >= 0),
        locked_until TEXT,
        last_login_at TEXT,
        password_changed_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX local_users_role_active_idx
        ON local_users(role, active, created_at);

      CREATE TABLE local_auth_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES local_users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX local_auth_sessions_user_active_idx
        ON local_auth_sessions(user_id, revoked_at, expires_at);
      CREATE INDEX local_auth_sessions_expiry_idx
        ON local_auth_sessions(expires_at);

      CREATE TABLE local_auth_events (
        id TEXT PRIMARY KEY,
        user_id TEXT REFERENCES local_users(id) ON DELETE SET NULL,
        event_type TEXT NOT NULL CHECK (event_type IN (
          'setup_completed', 'login_succeeded', 'login_failed',
          'account_locked', 'logout', 'session_revoked',
          'user_created', 'user_updated', 'user_deleted',
          'password_changed'
        )),
        actor_user_id TEXT REFERENCES local_users(id) ON DELETE SET NULL,
        data_json TEXT NOT NULL DEFAULT '{}',
        occurred_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX local_auth_events_time_idx
        ON local_auth_events(occurred_at DESC, id);
      CREATE INDEX local_auth_events_user_time_idx
        ON local_auth_events(user_id, occurred_at DESC);
    `,
  },
  {
    version: 18,
    name: "local_setup_challenge",
    sql: `
      CREATE TABLE local_setup_challenges (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        token_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 19,
    name: "configurable_ai_providers",
    sql: `
      CREATE TABLE ai_provider_connections (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL
          CHECK (provider_id IN ('codex', 'openai', 'anthropic', 'openrouter', 'ollama')),
        label TEXT NOT NULL,
        base_url TEXT,
        secret_ref TEXT,
        secret_last_four TEXT,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        config_json TEXT NOT NULL DEFAULT '{}',
        created_by TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX ai_provider_connections_enabled_idx
        ON ai_provider_connections(enabled, provider_id, label);

      CREATE TABLE ai_task_profiles (
        task_kind TEXT PRIMARY KEY
          CHECK (task_kind IN ('triage', 'automatic', 'deep')),
        connection_id TEXT REFERENCES ai_provider_connections(id) ON DELETE SET NULL,
        model TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        updated_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      INSERT INTO ai_provider_connections (
        id, provider_id, label, base_url, secret_ref, secret_last_four,
        enabled, config_json, created_by, updated_by, created_at, updated_at
      ) VALUES (
        'builtin-codex', 'codex', 'Codex CLI', NULL, NULL, NULL,
        1, '{}', 'migration', 'migration',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      );

      INSERT INTO ai_task_profiles (
        task_kind, connection_id, model, enabled, updated_by, created_at, updated_at
      )
      SELECT 'triage', 'builtin-codex', settings.model, settings.enabled,
             'migration', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
             strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      FROM triage_ai_settings settings WHERE settings.singleton = 1;

      INSERT OR IGNORE INTO ai_task_profiles (
        task_kind, connection_id, model, enabled, updated_by, created_at, updated_at
      ) VALUES (
        'triage', 'builtin-codex', 'default', 1, 'migration',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      );

      INSERT INTO ai_task_profiles (
        task_kind, connection_id, model, enabled, updated_by, created_at, updated_at
      ) VALUES
        ('automatic', 'builtin-codex', 'default', 1, 'migration',
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        ('deep', 'builtin-codex', 'default', 1, 'migration',
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

      ALTER TABLE investigation_jobs ADD COLUMN ai_provider_id TEXT;
      ALTER TABLE investigation_jobs ADD COLUMN ai_connection_id TEXT;
      ALTER TABLE investigation_jobs ADD COLUMN ai_model TEXT;
      ALTER TABLE investigation_thread_jobs ADD COLUMN ai_provider_id TEXT;
      ALTER TABLE investigation_thread_jobs ADD COLUMN ai_connection_id TEXT;
      ALTER TABLE investigation_thread_jobs ADD COLUMN ai_model TEXT;
      ALTER TABLE triage_ai_jobs ADD COLUMN provider_id TEXT NOT NULL DEFAULT 'codex';
      ALTER TABLE triage_ai_jobs ADD COLUMN connection_id TEXT;
    `,
  },
  {
    version: 20,
    name: "tool_free_automatic_ai_profiles",
    sql: `
      UPDATE ai_task_profiles
      SET connection_id = NULL,
          enabled = 0,
          updated_by = 'security-migration',
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE task_kind IN ('triage', 'automatic')
        AND connection_id IN (
          SELECT id FROM ai_provider_connections WHERE provider_id = 'codex'
        );

      UPDATE triage_ai_settings
      SET enabled = 0,
          updated_by = 'security-migration',
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE singleton = 1;

      UPDATE triage_ai_job_messages
      SET active = 0,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE active = 1
        AND job_id IN (
          SELECT id FROM triage_ai_jobs WHERE state IN ('queued', 'running')
        );

      UPDATE triage_ai_jobs
      SET state = 'failed',
          error = 'Configure um provedor de inferência sem ferramentas para retomar a triagem por IA',
          finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          claimed_at = NULL,
          lease_expires_at = NULL,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE state IN ('queued', 'running');
    `,
  },
  {
    version: 21,
    name: "task_scoped_codex_profiles",
    sql: `
      UPDATE ai_task_profiles
      SET connection_id = 'builtin-codex',
          enabled = 1,
          updated_by = 'codex-isolated-migration',
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE task_kind IN ('triage', 'automatic')
        AND connection_id IS NULL
        AND enabled = 0
        AND updated_by = 'security-migration'
        AND EXISTS (
          SELECT 1 FROM ai_provider_connections
          WHERE id = 'builtin-codex' AND provider_id = 'codex' AND enabled = 1
        );

      INSERT OR IGNORE INTO triage_ai_settings (
        singleton, enabled, model, updated_by, created_at, updated_at
      )
      SELECT 1, profile.enabled, profile.model, 'codex-isolated-migration',
             strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
             strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      FROM ai_task_profiles profile
      WHERE profile.task_kind = 'triage';

      UPDATE triage_ai_settings
      SET enabled = COALESCE((
            SELECT enabled FROM ai_task_profiles WHERE task_kind = 'triage'
          ), 0),
          model = COALESCE((
            SELECT model FROM ai_task_profiles WHERE task_kind = 'triage'
          ), model),
          updated_by = 'codex-isolated-migration',
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE singleton = 1
        AND updated_by = 'security-migration';
    `,
  },
  {
    version: 22,
    name: "local_deep_investigation_tools",
    sql: `
      CREATE TABLE local_tools (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN (
          'codebase', 'knowledge', 'debugger_skill', 'postgres_readonly',
          'clickhouse_readonly', 'aws_cloudwatch', 'vercel'
        )),
        name TEXT NOT NULL,
        description TEXT,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        deep_enabled INTEGER NOT NULL DEFAULT 1 CHECK (deep_enabled IN (0, 1)),
        allowed_operations_json TEXT NOT NULL DEFAULT '[]',
        config_json TEXT NOT NULL DEFAULT '{}',
        secret_ref TEXT,
        secret_fields_json TEXT NOT NULL DEFAULT '[]',
        last_tested_at TEXT,
        last_test_status TEXT CHECK (
          last_test_status IS NULL OR last_test_status IN ('success', 'failed')
        ),
        last_test_message TEXT,
        created_by TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX local_tools_deep_enabled_idx
        ON local_tools(enabled, deep_enabled, type, name);
    `,
  },
  {
    version: 23,
    name: "append_only_deep_tool_execution_audit",
    sql: `
      CREATE TABLE investigation_thread_tool_executions (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL
          REFERENCES investigation_thread_jobs(id) ON DELETE CASCADE,
        request_id TEXT NOT NULL,
        tool_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        operation TEXT NOT NULL,
        arguments_json TEXT NOT NULL,
        purpose TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('success', 'error')),
        summary TEXT NOT NULL,
        content TEXT NOT NULL,
        reference TEXT,
        executed_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        UNIQUE(job_id, request_id)
      ) STRICT;

      CREATE INDEX investigation_thread_tool_executions_job_time_idx
        ON investigation_thread_tool_executions(job_id, executed_at, id);

      CREATE TRIGGER investigation_thread_tool_executions_no_update
      BEFORE UPDATE ON investigation_thread_tool_executions
      BEGIN
        SELECT RAISE(ABORT, 'tool execution audit is append-only');
      END;
    `,
  },
  {
    version: 24,
    name: "idempotent_legacy_tool_imports",
    sql: `
      ALTER TABLE local_tools ADD COLUMN legacy_source_ref TEXT;

      CREATE UNIQUE INDEX local_tools_legacy_source_ref_unique
        ON local_tools(legacy_source_ref)
        WHERE legacy_source_ref IS NOT NULL;
    `,
  },
  {
    version: 25,
    name: "agnostic_directory_records",
    sql: `
      CREATE TABLE directory_record_types (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        plural_name TEXT NOT NULL,
        slug TEXT NOT NULL COLLATE NOCASE UNIQUE,
        description TEXT,
        icon TEXT,
        color TEXT,
        system INTEGER NOT NULL DEFAULT 0 CHECK (system IN (0, 1)),
        archived_at TEXT,
        archived_by TEXT,
        created_by TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX directory_record_types_active_name_idx
        ON directory_record_types(archived_at, name);

      CREATE TABLE directory_field_definitions (
        id TEXT PRIMARY KEY,
        record_type_id TEXT NOT NULL
          REFERENCES directory_record_types(id) ON DELETE RESTRICT,
        key TEXT NOT NULL COLLATE NOCASE,
        label TEXT NOT NULL,
        field_type TEXT NOT NULL CHECK (field_type IN (
          'text', 'number', 'boolean', 'date', 'url', 'select',
          'multi_select', 'relation'
        )),
        required INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0, 1)),
        options_json TEXT NOT NULL DEFAULT '[]',
        relation_record_type_id TEXT
          REFERENCES directory_record_types(id) ON DELETE RESTRICT,
        position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
        archived_at TEXT,
        archived_by TEXT,
        created_by TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(record_type_id, key),
        CHECK (
          (field_type = 'relation' AND relation_record_type_id IS NOT NULL)
          OR (field_type <> 'relation' AND relation_record_type_id IS NULL)
        )
      ) STRICT;

      CREATE INDEX directory_field_definitions_type_position_idx
        ON directory_field_definitions(record_type_id, archived_at, position, label);
      CREATE INDEX directory_field_definitions_relation_type_idx
        ON directory_field_definitions(relation_record_type_id)
        WHERE relation_record_type_id IS NOT NULL;

      CREATE TABLE directory_records (
        id TEXT PRIMARY KEY,
        record_type_id TEXT NOT NULL
          REFERENCES directory_record_types(id) ON DELETE RESTRICT,
        legacy_client_id TEXT UNIQUE REFERENCES clients(id) ON DELETE SET NULL,
        legacy_store_id TEXT UNIQUE REFERENCES client_stores(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        slug TEXT NOT NULL COLLATE NOCASE,
        description TEXT,
        source TEXT NOT NULL DEFAULT 'manual'
          CHECK (source IN ('manual', 'legacy_client', 'legacy_store', 'import', 'ai')),
        archived_at TEXT,
        archived_by TEXT,
        created_by TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(record_type_id, slug)
      ) STRICT;

      CREATE INDEX directory_records_type_active_name_idx
        ON directory_records(record_type_id, archived_at, name);
      CREATE INDEX directory_records_legacy_client_idx
        ON directory_records(legacy_client_id)
        WHERE legacy_client_id IS NOT NULL;
      CREATE INDEX directory_records_legacy_store_idx
        ON directory_records(legacy_store_id)
        WHERE legacy_store_id IS NOT NULL;

      CREATE TABLE directory_field_values (
        record_id TEXT NOT NULL REFERENCES directory_records(id) ON DELETE RESTRICT,
        field_id TEXT NOT NULL
          REFERENCES directory_field_definitions(id) ON DELETE RESTRICT,
        value_json TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (record_id, field_id)
      ) WITHOUT ROWID;

      CREATE INDEX directory_field_values_field_idx
        ON directory_field_values(field_id, record_id);

      CREATE TABLE directory_group_links (
        record_id TEXT NOT NULL REFERENCES directory_records(id) ON DELETE RESTRICT,
        group_id TEXT NOT NULL REFERENCES whatsapp_groups(id) ON DELETE RESTRICT,
        archived_at TEXT,
        archived_by TEXT,
        created_by TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (record_id, group_id)
      ) WITHOUT ROWID;

      CREATE INDEX directory_group_links_group_active_idx
        ON directory_group_links(group_id, archived_at, record_id);

      CREATE TABLE directory_person_links (
        record_id TEXT NOT NULL REFERENCES directory_records(id) ON DELETE RESTRICT,
        participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE RESTRICT,
        archived_at TEXT,
        archived_by TEXT,
        created_by TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (record_id, participant_id)
      ) WITHOUT ROWID;

      CREATE INDEX directory_person_links_person_active_idx
        ON directory_person_links(participant_id, archived_at, record_id);

      CREATE TABLE directory_record_links (
        id TEXT PRIMARY KEY,
        source_record_id TEXT NOT NULL
          REFERENCES directory_records(id) ON DELETE RESTRICT,
        target_record_id TEXT NOT NULL
          REFERENCES directory_records(id) ON DELETE RESTRICT,
        field_definition_id TEXT
          REFERENCES directory_field_definitions(id) ON DELETE RESTRICT,
        relationship_key TEXT NOT NULL DEFAULT 'related',
        archived_at TEXT,
        archived_by TEXT,
        created_by TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (source_record_id <> target_record_id)
      ) STRICT;

      CREATE UNIQUE INDEX directory_record_links_active_unique
        ON directory_record_links(
          source_record_id,
          target_record_id,
          relationship_key,
          COALESCE(field_definition_id, '')
        )
        WHERE archived_at IS NULL;
      CREATE INDEX directory_record_links_target_active_idx
        ON directory_record_links(target_record_id, archived_at, source_record_id);
      CREATE INDEX directory_record_links_field_active_idx
        ON directory_record_links(field_definition_id, archived_at, source_record_id)
        WHERE field_definition_id IS NOT NULL;

      CREATE TABLE directory_segments (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        record_type_id TEXT
          REFERENCES directory_record_types(id) ON DELETE RESTRICT,
        match_mode TEXT NOT NULL CHECK (match_mode IN ('all', 'any')),
        filters_json TEXT NOT NULL DEFAULT '[]',
        archived_at TEXT,
        archived_by TEXT,
        created_by TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX directory_segments_active_name_idx
        ON directory_segments(archived_at, name);
      CREATE INDEX directory_segments_type_active_idx
        ON directory_segments(record_type_id, archived_at, name)
        WHERE record_type_id IS NOT NULL;

      CREATE TABLE ticket_record_links (
        ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        record_id TEXT NOT NULL REFERENCES directory_records(id) ON DELETE RESTRICT,
        relationship_key TEXT NOT NULL DEFAULT 'context',
        archived_at TEXT,
        archived_by TEXT,
        created_by TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (ticket_id, record_id, relationship_key)
      ) WITHOUT ROWID;

      CREATE INDEX ticket_record_links_record_active_idx
        ON ticket_record_links(record_id, archived_at, ticket_id);
      CREATE INDEX messages_sender_occurred_idx
        ON messages(sender_id, occurred_at DESC);

      INSERT INTO directory_record_types (
        id, name, plural_name, slug, description, icon, color, system,
        archived_at, archived_by, created_by, updated_by, created_at, updated_at
      ) VALUES (
        'directory-type-organization',
        'Organização',
        'Organizações',
        'organizacao',
        'Registro genérico para organizar grupos e pessoas sem impor um modelo de negócio.',
        'building-2',
        '#6558e8',
        1,
        NULL,
        NULL,
        'migration',
        'migration',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      );

      INSERT INTO directory_record_types (
        id, name, plural_name, slug, description, icon, color, system,
        archived_at, archived_by, created_by, updated_by, created_at, updated_at
      )
      SELECT
        'directory-type-agency',
        'Agência',
        'Agências',
        'agencia',
        'Agência migrada de uma classificação explícita deste workspace.',
        'briefcase-business',
        '#7c3aed',
        1,
        NULL,
        NULL,
        'migration',
        'migration',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE EXISTS (
        SELECT 1
        FROM clients c
        WHERE c.ignored_at IS NULL
          AND c.kind = 'agency'
          AND (
            c.manual_override = 1
            OR EXISTS (
              SELECT 1 FROM client_stores s
              WHERE s.client_id = c.id AND s.active = 1
            )
            OR (
              SELECT COUNT(*) FROM whatsapp_groups g
              WHERE g.client_id = c.id AND g.external_jid LIKE '%@g.us'
            ) > 1
          )
      );

      INSERT INTO directory_record_types (
        id, name, plural_name, slug, description, icon, color, system,
        archived_at, archived_by, created_by, updated_by, created_at, updated_at
      )
      SELECT
        'directory-type-ecommerce',
        'Ecommerce',
        'Ecommerces',
        'ecommerce',
        'Ecommerce migrado de uma classificação explícita deste workspace.',
        'store',
        '#0f9f75',
        1,
        NULL,
        NULL,
        'migration',
        'migration',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE EXISTS (
        SELECT 1
        FROM clients c
        WHERE c.ignored_at IS NULL
          AND (
            (
              c.kind = 'ecommerce'
              AND (
                c.manual_override = 1
                OR EXISTS (
                  SELECT 1 FROM client_stores s
                  WHERE s.client_id = c.id AND s.active = 1
                )
                OR (
                  SELECT COUNT(*) FROM whatsapp_groups g
                  WHERE g.client_id = c.id AND g.external_jid LIKE '%@g.us'
                ) > 1
              )
            )
            OR (
              c.kind = 'agency'
              AND EXISTS (
                SELECT 1 FROM client_stores s
                WHERE s.client_id = c.id AND s.active = 1
              )
            )
          )
      );

      INSERT INTO directory_records (
        id, record_type_id, legacy_client_id, legacy_store_id, name, slug,
        description, source, archived_at, archived_by, created_by, updated_by,
        created_at, updated_at
      )
      SELECT
        'directory-client-' || c.id,
        CASE c.kind
          WHEN 'agency' THEN 'directory-type-agency'
          ELSE 'directory-type-ecommerce'
        END,
        c.id,
        NULL,
        c.name,
        c.slug,
        c.notes,
        'legacy_client',
        NULL,
        NULL,
        'migration',
        'migration',
        c.created_at,
        c.updated_at
      FROM clients c
      WHERE c.ignored_at IS NULL
        AND (
          c.manual_override = 1
          OR EXISTS (
            SELECT 1 FROM client_stores s
            WHERE s.client_id = c.id AND s.active = 1
          )
          OR (
            SELECT COUNT(*) FROM whatsapp_groups g
            WHERE g.client_id = c.id AND g.external_jid LIKE '%@g.us'
          ) > 1
        );

      INSERT INTO directory_records (
        id, record_type_id, legacy_client_id, legacy_store_id, name, slug,
        description, source, archived_at, archived_by, created_by, updated_by,
        created_at, updated_at
      )
      SELECT
        'directory-store-' || s.id,
        'directory-type-ecommerce',
        NULL,
        s.id,
        s.name,
        'store-' || s.id,
        CASE
          WHEN s.platform IS NOT NULL AND s.business_id IS NOT NULL
            THEN 'Plataforma: ' || s.platform || ' · Business ID: ' || s.business_id
          WHEN s.platform IS NOT NULL THEN 'Plataforma: ' || s.platform
          WHEN s.business_id IS NOT NULL THEN 'Business ID: ' || s.business_id
          ELSE NULL
        END,
        'legacy_store',
        NULL,
        NULL,
        'migration',
        'migration',
        s.created_at,
        s.updated_at
      FROM client_stores s
      JOIN clients c ON c.id = s.client_id
      WHERE s.active = 1
        AND c.ignored_at IS NULL
        AND c.kind = 'agency'
        AND EXISTS (
          SELECT 1 FROM directory_records parent
          WHERE parent.legacy_client_id = c.id
        );

      INSERT INTO directory_group_links (
        record_id, group_id, archived_at, archived_by, created_by, updated_by,
        created_at, updated_at
      )
      SELECT
        record.id,
        group_row.id,
        NULL,
        NULL,
        'migration',
        'migration',
        group_row.created_at,
        group_row.updated_at
      FROM directory_records record
      JOIN whatsapp_groups group_row
        ON group_row.client_id = record.legacy_client_id
      WHERE record.legacy_client_id IS NOT NULL
        AND group_row.external_jid LIKE '%@g.us';

      INSERT INTO directory_record_links (
        id, source_record_id, target_record_id, field_definition_id,
        relationship_key, archived_at, archived_by, created_by, updated_by,
        created_at, updated_at
      )
      SELECT
        'directory-legacy-store-link-' || store_record.legacy_store_id,
        client_record.id,
        store_record.id,
        NULL,
        'contains',
        NULL,
        NULL,
        'migration',
        'migration',
        store_record.created_at,
        store_record.updated_at
      FROM directory_records store_record
      JOIN client_stores store_row ON store_row.id = store_record.legacy_store_id
      JOIN directory_records client_record
        ON client_record.legacy_client_id = store_row.client_id
      WHERE store_record.legacy_store_id IS NOT NULL;

      INSERT INTO ticket_record_links (
        ticket_id, record_id, relationship_key, archived_at, archived_by,
        created_by, updated_by, created_at, updated_at
      )
      SELECT
        ticket.id,
        record.id,
        'context',
        NULL,
        NULL,
        'migration',
        'migration',
        ticket.created_at,
        ticket.updated_at
      FROM tickets ticket
      JOIN directory_records record ON record.legacy_client_id = ticket.client_id;

      INSERT INTO ticket_record_links (
        ticket_id, record_id, relationship_key, archived_at, archived_by,
        created_by, updated_by, created_at, updated_at
      )
      SELECT
        ticket.id,
        record.id,
        'affected',
        NULL,
        NULL,
        'migration',
        'migration',
        ticket.created_at,
        ticket.updated_at
      FROM tickets ticket
      JOIN directory_records record
        ON record.legacy_store_id = ticket.affected_store_id
      WHERE ticket.affected_store_id IS NOT NULL;
    `,
  },
  {
    version: 26,
    name: "clean_placeholder_participant_identities",
    sql: `
      DELETE FROM participants
      WHERE (
          lower(trim(display_name)) = 'participante'
          OR lower(trim(display_name)) LIKE 'participante %'
        )
        AND NOT EXISTS (
          SELECT 1 FROM messages
          WHERE messages.sender_id = participants.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM message_reaction_events
          WHERE message_reaction_events.reactor_id = participants.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM triage_blocks
          WHERE triage_blocks.sender_id = participants.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM directory_person_links
          WHERE directory_person_links.participant_id = participants.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM whatsapp_identity_links
          WHERE whatsapp_identity_links.lid_jid = participants.external_jid
             OR whatsapp_identity_links.phone_jid = participants.external_jid
        )
        AND NOT EXISTS (
          SELECT 1 FROM staff_members
          WHERE staff_members.participant_id = participants.id
        );

      UPDATE participants
      SET phone_e164 = COALESCE(
        phone_e164,
        CASE
          WHEN external_jid LIKE '%@s.whatsapp.net'
            AND substr(external_jid, 1, instr(external_jid, '@') - 1)
              NOT GLOB '*[^0-9]*'
            AND length(substr(external_jid, 1, instr(external_jid, '@') - 1))
              BETWEEN 7 AND 15
          THEN '+' || substr(external_jid, 1, instr(external_jid, '@') - 1)
          ELSE NULL
        END,
        (
          SELECT '+' || substr(link.phone_jid, 1, instr(link.phone_jid, '@') - 1)
          FROM whatsapp_identity_links link
          WHERE link.lid_jid = participants.external_jid
            AND link.phone_jid LIKE '%@s.whatsapp.net'
            AND substr(link.phone_jid, 1, instr(link.phone_jid, '@') - 1)
              NOT GLOB '*[^0-9]*'
            AND length(substr(link.phone_jid, 1, instr(link.phone_jid, '@') - 1))
              BETWEEN 7 AND 15
          LIMIT 1
        )
      )
      WHERE lower(trim(display_name)) = 'participante'
         OR lower(trim(display_name)) LIKE 'participante %';

      UPDATE participants AS placeholder
      SET display_name = COALESCE(
        (
          SELECT counterpart.display_name
          FROM whatsapp_identity_links link
          JOIN participants counterpart
            ON counterpart.external_jid = link.phone_jid
          WHERE link.lid_jid = placeholder.external_jid
            AND lower(trim(counterpart.display_name)) <> 'participante'
            AND lower(trim(counterpart.display_name)) NOT LIKE 'participante %'
            AND trim(counterpart.display_name) <> counterpart.external_jid
            AND trim(counterpart.display_name) <>
              substr(counterpart.external_jid, 1, instr(counterpart.external_jid, '@') - 1)
          LIMIT 1
        ),
        placeholder.phone_e164,
        placeholder.external_jid
      ),
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE lower(trim(placeholder.display_name)) = 'participante'
         OR lower(trim(placeholder.display_name)) LIKE 'participante %';
    `,
  },
  {
    version: 27,
    name: "ticket_product_forwardings",
    sql: `
      CREATE TABLE ticket_product_forwardings (
        ticket_id TEXT PRIMARY KEY
          REFERENCES tickets(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind = 'bug'),
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        external_reference TEXT,
        created_by TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) WITHOUT ROWID;

      CREATE INDEX ticket_product_forwardings_kind_updated_idx
        ON ticket_product_forwardings(kind, updated_at DESC, ticket_id);
      CREATE INDEX ticket_product_forwardings_external_reference_idx
        ON ticket_product_forwardings(external_reference)
        WHERE external_reference IS NOT NULL;
    `,
  },
  {
    version: 28,
    name: "investigation_thread_cancellation",
    sql: `
      ALTER TABLE investigation_thread_jobs ADD COLUMN cancelled_at TEXT;
      ALTER TABLE investigation_thread_jobs ADD COLUMN cancelled_by TEXT;

      CREATE INDEX investigation_thread_jobs_cancelled_idx
        ON investigation_thread_jobs(thread_id, cancelled_at DESC)
        WHERE cancelled_at IS NOT NULL;
    `,
  },
  {
    version: 29,
    name: "deliberate_triage_and_knowledge_assessments",
    sql: `
      ALTER TABLE triage_ai_settings
        ADD COLUMN silence_window_seconds INTEGER NOT NULL DEFAULT 180
          CHECK (silence_window_seconds BETWEEN 30 AND 1800);

      CREATE TABLE triage_context_waits (
        group_id TEXT PRIMARY KEY
          REFERENCES whatsapp_groups(id) ON DELETE CASCADE,
        message_ids_json TEXT NOT NULL,
        reason TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) WITHOUT ROWID;

      CREATE TABLE knowledge_assessments (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL UNIQUE
          REFERENCES tickets(id) ON DELETE CASCADE,
        resolution_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL
          CHECK (status IN (
            'insufficient_context',
            'not_reusable',
            'eligible',
            'draft_created',
            'dismissed'
          )),
        reason TEXT NOT NULL,
        suggested_title TEXT,
        suggested_content TEXT,
        confidence REAL CHECK (
          confidence IS NULL OR (confidence >= 0 AND confidence <= 1)
        ),
        knowledge_candidate_id TEXT
          REFERENCES knowledge_candidates(id) ON DELETE SET NULL,
        assessed_by TEXT NOT NULL,
        assessed_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX knowledge_assessments_status_updated_idx
        ON knowledge_assessments(status, updated_at DESC);
    `,
  },
  {
    version: 30,
    name: "active_knowledge_bases",
    sql: `
      DELETE FROM knowledge_candidates
      WHERE status IN ('candidate', 'rejected');

      INSERT INTO knowledge_candidate_events
        (id, knowledge_candidate_id, event_type, actor, from_status, to_status,
         reason, data_json, occurred_at)
      SELECT
        lower(hex(randomblob(16))),
        id,
        'status_changed',
        'Migração Threadmark',
        'published',
        'approved',
        'Publicação incorporada ao estado ativo.',
        '{"migration":"active_knowledge_bases"}',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      FROM knowledge_candidates
      WHERE status = 'published';

      UPDATE knowledge_candidates
      SET status = 'approved',
          status_changed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          status_changed_by = 'Migração Threadmark',
          archived_at = NULL,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE status = 'published';
    `,
  },
  {
    version: 31,
    name: "supersede_answered_suggestions",
    sql: `
      UPDATE suggestions AS suggestion
      SET status = 'superseded',
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE suggestion.status = 'candidate'
        AND (
          EXISTS (
            SELECT 1
            FROM sent_responses AS response
            WHERE response.ticket_id = suggestion.ticket_id
              AND (
                response.sent_at >= suggestion.created_at
                OR lower(trim(response.body)) = lower(trim(suggestion.body))
              )
          )
          OR EXISTS (
            SELECT 1
            FROM ticket_messages AS ticket_message
            JOIN messages AS message ON message.id = ticket_message.message_id
            LEFT JOIN staff_members AS staff
              ON staff.participant_id = message.sender_id AND staff.active = 1
            WHERE ticket_message.ticket_id = suggestion.ticket_id
              AND staff.participant_id IS NULL
              AND ticket_message.added_at > suggestion.created_at
          )
        );
    `,
  },
  {
    version: 32,
    name: "manual_category_catalog",
    sql: `
      ALTER TABLE categories
        ADD COLUMN origin TEXT NOT NULL DEFAULT 'system'
          CHECK (origin IN ('system', 'manual'));
    `,
  },
  {
    version: 33,
    name: "editable_ticket_requester",
    sql: `
      ALTER TABLE tickets
        ADD COLUMN requester_id TEXT
          REFERENCES participants(id) ON DELETE SET NULL;

      CREATE INDEX IF NOT EXISTS tickets_requester_updated_idx
        ON tickets(requester_id, updated_at DESC);
    `,
  },
  {
    version: 34,
    name: "ticket_external_record_links",
    sql: `
      CREATE TABLE external_records (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL CHECK (provider = 'linear'),
        external_type TEXT NOT NULL CHECK (external_type = 'issue'),
        external_id TEXT NOT NULL,
        external_url TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL
          CHECK (status IN ('unknown', 'backlog', 'in_progress', 'resolved', 'canceled')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(provider, external_type, external_id)
      ) STRICT;

      CREATE TABLE ticket_external_record_links (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL
          REFERENCES tickets(id) ON DELETE CASCADE,
        external_record_id TEXT NOT NULL
          REFERENCES external_records(id) ON DELETE CASCADE,
        linked_by TEXT NOT NULL,
        linked_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(ticket_id, external_record_id)
      ) STRICT;

      CREATE INDEX ticket_external_record_links_ticket_idx
        ON ticket_external_record_links(ticket_id, linked_at DESC);
      CREATE INDEX ticket_external_record_links_record_idx
        ON ticket_external_record_links(external_record_id, linked_at DESC);
    `,
  },
  {
    version: 35,
    name: "agnostic_record_connectors",
    sql: `
      CREATE TABLE record_connectors (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        method TEXT NOT NULL CHECK (method IN ('POST', 'PUT', 'PATCH')),
        url_template TEXT NOT NULL,
        headers_template TEXT NOT NULL DEFAULT '{}',
        body_template TEXT NOT NULL DEFAULT '{}',
        target_record_type_id TEXT NOT NULL
          REFERENCES directory_record_types(id) ON DELETE RESTRICT,
        record_name_path TEXT NOT NULL,
        record_description_path TEXT,
        input_fields_json TEXT NOT NULL DEFAULT '[]',
        field_mappings_json TEXT NOT NULL DEFAULT '[]',
        secret_ref TEXT,
        token_last_four TEXT,
        archived_at TEXT,
        created_by TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX record_connectors_active_name_idx
        ON record_connectors(archived_at, enabled, name COLLATE NOCASE);

      CREATE TABLE record_connector_executions (
        id TEXT PRIMARY KEY,
        connector_id TEXT NOT NULL
          REFERENCES record_connectors(id) ON DELETE RESTRICT,
        ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        client_request_id TEXT NOT NULL,
        status TEXT NOT NULL
          CHECK (status IN ('running', 'succeeded', 'failed')),
        http_status INTEGER,
        record_id TEXT REFERENCES directory_records(id) ON DELETE SET NULL,
        error TEXT,
        requested_by TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        UNIQUE(connector_id, ticket_id, client_request_id)
      ) STRICT;

      CREATE INDEX record_connector_executions_ticket_idx
        ON record_connector_executions(ticket_id, started_at DESC);
    `,
  },
  {
    version: 36,
    name: "local_audio_transcription",
    sql: `
      ALTER TABLE attachments RENAME TO attachments_v35;

      CREATE TABLE attachments (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        kind TEXT NOT NULL
          CHECK (kind IN ('image', 'pdf', 'document', 'video', 'audio', 'other')),
        mime_type TEXT NOT NULL,
        file_name TEXT,
        local_path TEXT NOT NULL,
        size_bytes INTEGER,
        sha256 TEXT NOT NULL,
        source_key TEXT UNIQUE,
        extracted_text TEXT,
        available INTEGER NOT NULL DEFAULT 1 CHECK (available IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(message_id, sha256)
      ) STRICT;

      INSERT INTO attachments (
        id, message_id, kind, mime_type, file_name, local_path, size_bytes,
        sha256, source_key, extracted_text, available, created_at, updated_at
      )
      SELECT
        id, message_id, kind, mime_type, file_name, local_path, size_bytes,
        sha256, source_key, extracted_text, available, created_at, updated_at
      FROM attachments_v35;

      DROP TABLE attachments_v35;

      CREATE TABLE audio_transcription_settings (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
        model_id TEXT NOT NULL DEFAULT 'onnx-community/whisper-small',
        language TEXT NOT NULL DEFAULT 'pt',
        auto_transcribe_new INTEGER NOT NULL DEFAULT 1
          CHECK (auto_transcribe_new IN (0, 1)),
        updated_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      INSERT INTO audio_transcription_settings (
        singleton, enabled, model_id, language, auto_transcribe_new,
        updated_by, created_at, updated_at
      ) VALUES (
        1, 0, 'onnx-community/whisper-small', 'pt', 1,
        'default', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      );

      CREATE TABLE local_transcription_models (
        model_id TEXT PRIMARY KEY,
        state TEXT NOT NULL
          CHECK (state IN ('not_installed', 'downloading', 'installed', 'error')),
        progress REAL NOT NULL DEFAULT 0
          CHECK (progress >= 0 AND progress <= 1),
        cache_bytes INTEGER NOT NULL DEFAULT 0 CHECK (cache_bytes >= 0),
        error TEXT,
        installed_at TEXT,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE audio_transcriptions (
        attachment_id TEXT PRIMARY KEY
          REFERENCES attachments(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        status TEXT NOT NULL
          CHECK (status IN ('queued', 'processing', 'completed', 'review', 'failed')),
        source TEXT NOT NULL CHECK (source IN ('realtime', 'manual_history')),
        model_id TEXT NOT NULL,
        language TEXT NOT NULL,
        text TEXT,
        confidence REAL CHECK (
          confidence IS NULL OR (confidence >= 0 AND confidence <= 1)
        ),
        duration_seconds REAL,
        error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        requested_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX audio_transcriptions_status_requested_idx
        ON audio_transcriptions(status, requested_at, attachment_id);
      CREATE INDEX audio_transcriptions_message_idx
        ON audio_transcriptions(message_id, updated_at DESC);
    `,
  },
  {
    version: 37,
    name: "remove_knowledge_bases",
    sql: `
      DROP TABLE IF EXISTS knowledge_assessments;
      DROP TABLE IF EXISTS knowledge_candidate_events;
      DROP TABLE IF EXISTS knowledge_candidates;
    `,
  },
  {
    version: 38,
    name: "ticket_team_assignment",
    sql: `
      ALTER TABLE tickets
        ADD COLUMN assignee_user_id TEXT
          REFERENCES local_users(id) ON DELETE SET NULL;

      CREATE INDEX tickets_assignee_status_updated_idx
        ON tickets(assignee_user_id, status, updated_at DESC);
    `,
  },
  {
    version: 39,
    name: "remove_directory_records_and_segments",
    sql: `
      DELETE FROM ticket_events
      WHERE event_type = 'ticket_directory_context_changed';

      DROP TABLE IF EXISTS record_connector_executions;
      DROP TABLE IF EXISTS record_connectors;
      DROP TABLE IF EXISTS ticket_record_links;
      DROP TABLE IF EXISTS directory_record_links;
      DROP TABLE IF EXISTS directory_field_values;
      DROP TABLE IF EXISTS directory_group_links;
      DROP TABLE IF EXISTS directory_person_links;
      DROP TABLE IF EXISTS directory_segments;
      DROP TABLE IF EXISTS directory_field_definitions;
      DROP TABLE IF EXISTS directory_records;
      DROP TABLE IF EXISTS directory_record_types;
    `,
  },
  {
    version: 40,
    name: "documentation_drafts",
    sql: `
      ALTER TABLE ai_task_profiles RENAME TO ai_task_profiles_v39;

      CREATE TABLE ai_task_profiles (
        task_kind TEXT PRIMARY KEY
          CHECK (task_kind IN ('triage', 'automatic', 'deep', 'documentation')),
        connection_id TEXT REFERENCES ai_provider_connections(id) ON DELETE SET NULL,
        model TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        updated_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      INSERT INTO ai_task_profiles (
        task_kind, connection_id, model, enabled, updated_by, created_at, updated_at
      )
      SELECT task_kind, connection_id, model, enabled, updated_by, created_at, updated_at
      FROM ai_task_profiles_v39;

      INSERT INTO ai_task_profiles (
        task_kind, connection_id, model, enabled, updated_by, created_at, updated_at
      )
      SELECT
        'documentation', connection_id, model, enabled, 'migration-40',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      FROM ai_task_profiles_v39
      WHERE task_kind = 'deep';

      DROP TABLE ai_task_profiles_v39;

      CREATE TABLE documentation_drafts (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL UNIQUE REFERENCES tickets(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'draft'
          CHECK (status IN ('draft', 'ready', 'archived')),
        title TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '',
        audience TEXT NOT NULL DEFAULT '',
        body_markdown TEXT NOT NULL DEFAULT '',
        prerequisites_json TEXT NOT NULL DEFAULT '[]',
        warnings_json TEXT NOT NULL DEFAULT '[]',
        source_message_ids_json TEXT NOT NULL DEFAULT '[]',
        image_placements_json TEXT NOT NULL DEFAULT '[]',
        ai_provider_id TEXT,
        ai_connection_id TEXT,
        ai_model TEXT,
        prompt_version TEXT,
        generated_at TEXT,
        reviewed_at TEXT,
        reviewed_by TEXT,
        created_by TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX documentation_drafts_status_updated_idx
        ON documentation_drafts(status, updated_at DESC);

      CREATE TABLE documentation_generation_jobs (
        id TEXT PRIMARY KEY,
        draft_id TEXT NOT NULL REFERENCES documentation_drafts(id) ON DELETE CASCADE,
        state TEXT NOT NULL DEFAULT 'queued'
          CHECK (state IN ('queued', 'running', 'completed', 'failed')),
        requested_by TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        claimed_at TEXT,
        lease_expires_at TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        error TEXT,
        ai_provider_id TEXT,
        ai_connection_id TEXT,
        ai_model TEXT
      ) STRICT;

      CREATE INDEX documentation_generation_jobs_queue_idx
        ON documentation_generation_jobs(state, requested_at, id);
      CREATE UNIQUE INDEX documentation_generation_jobs_active_idx
        ON documentation_generation_jobs(draft_id)
        WHERE state IN ('queued', 'running');
    `,
  },
  {
    version: 41,
    name: "durable_automation_engine",
    sql: `
      CREATE TABLE automation_workflows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'draft'
          CHECK (status IN ('draft', 'active', 'paused', 'archived')),
        current_version INTEGER NOT NULL DEFAULT 1 CHECK (current_version > 0),
        created_by TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX automation_workflows_status_updated_idx
        ON automation_workflows(status, updated_at DESC);

      CREATE TABLE automation_workflow_versions (
        workflow_id TEXT NOT NULL
          REFERENCES automation_workflows(id) ON DELETE CASCADE,
        version INTEGER NOT NULL CHECK (version > 0),
        definition_json TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workflow_id, version)
      ) WITHOUT ROWID;

      CREATE TABLE automation_events (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        subject_type TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL DEFAULT '{}',
        occurred_at TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'queued'
          CHECK (state IN ('queued', 'processing', 'completed', 'failed')),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        available_at TEXT NOT NULL,
        lease_expires_at TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        processed_at TEXT
      ) STRICT;

      CREATE INDEX automation_events_queue_idx
        ON automation_events(state, available_at, occurred_at, id);

      CREATE TABLE automation_runs (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        workflow_version INTEGER NOT NULL,
        event_id TEXT REFERENCES automation_events(id) ON DELETE SET NULL,
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued'
          CHECK (status IN (
            'queued', 'running', 'waiting', 'paused',
            'completed', 'failed', 'cancelled'
          )),
        input_json TEXT NOT NULL DEFAULT '{}',
        last_error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        updated_at TEXT NOT NULL,
        finished_at TEXT,
        FOREIGN KEY (workflow_id, workflow_version)
          REFERENCES automation_workflow_versions(workflow_id, version)
          ON DELETE RESTRICT,
        UNIQUE(workflow_id, idempotency_key)
      ) STRICT;

      CREATE INDEX automation_runs_status_updated_idx
        ON automation_runs(status, updated_at, id);
      CREATE INDEX automation_runs_workflow_created_idx
        ON automation_runs(workflow_id, created_at DESC);

      CREATE TABLE automation_run_steps (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
        node_id TEXT NOT NULL,
        node_type TEXT NOT NULL
          CHECK (node_type IN (
            'trigger', 'condition', 'wait', 'approval',
            'internal_action', 'app_action'
          )),
        status TEXT NOT NULL DEFAULT 'queued'
          CHECK (status IN (
            'queued', 'running', 'sleeping', 'awaiting_approval',
            'retry', 'completed', 'failed', 'cancelled', 'skipped'
          )),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        max_attempts INTEGER NOT NULL DEFAULT 1 CHECK (max_attempts BETWEEN 1 AND 5),
        idempotency_key TEXT NOT NULL UNIQUE,
        input_json TEXT NOT NULL DEFAULT '{}',
        output_json TEXT,
        available_at TEXT NOT NULL,
        lease_expires_at TEXT,
        error TEXT,
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(run_id, node_id)
      ) STRICT;

      CREATE INDEX automation_run_steps_queue_idx
        ON automation_run_steps(status, available_at, run_id, id);
      CREATE INDEX automation_run_steps_run_idx
        ON automation_run_steps(run_id, created_at, id);
    `,
  },
  {
    version: 42,
    name: "connected_apps_and_automation_event_cursor",
    sql: `
      CREATE TABLE connected_apps (
        id TEXT PRIMARY KEY,
        provider_type TEXT NOT NULL
          CHECK (provider_type IN ('slack_webhook', 'custom_http')),
        name TEXT NOT NULL,
        description TEXT,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        config_json TEXT NOT NULL DEFAULT '{}',
        secret_ref TEXT,
        secret_configured INTEGER NOT NULL DEFAULT 0
          CHECK (secret_configured IN (0, 1)),
        last_tested_at TEXT,
        last_test_status TEXT
          CHECK (last_test_status IS NULL OR last_test_status IN ('success', 'failed')),
        last_test_message TEXT,
        created_by TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX connected_apps_enabled_name_idx
        ON connected_apps(enabled DESC, name COLLATE NOCASE, id);

      CREATE TABLE automation_event_cursors (
        source TEXT PRIMARY KEY,
        occurred_at TEXT NOT NULL,
        event_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) WITHOUT ROWID;
    `,
  },
  {
    version: 43,
    name: "in_app_notifications",
    sql: `
      CREATE TABLE notifications (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES local_users(id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL,
        source_type TEXT NOT NULL CHECK (source_type IN ('automation', 'investigation', 'system')),
        source_id TEXT,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        target_url TEXT,
        tone TEXT NOT NULL DEFAULT 'info'
          CHECK (tone IN ('info', 'success', 'warning', 'urgent')),
        read_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(user_id, idempotency_key)
      ) STRICT;

      CREATE INDEX notifications_user_created_idx
        ON notifications(user_id, created_at DESC, id DESC);
      CREATE INDEX notifications_user_unread_idx
        ON notifications(user_id, read_at, created_at DESC);
      CREATE INDEX notifications_source_idx
        ON notifications(source_type, source_id, created_at DESC);
    `,
  },
  {
    version: 44,
    name: "replace_web_push_with_in_app_notifications",
    sql: `
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES local_users(id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL,
        source_type TEXT NOT NULL CHECK (source_type IN ('automation', 'investigation', 'system')),
        source_id TEXT,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        target_url TEXT,
        tone TEXT NOT NULL DEFAULT 'info'
          CHECK (tone IN ('info', 'success', 'warning', 'urgent')),
        read_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(user_id, idempotency_key)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS notifications_user_created_idx
        ON notifications(user_id, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS notifications_user_unread_idx
        ON notifications(user_id, read_at, created_at DESC);
      CREATE INDEX IF NOT EXISTS notifications_source_idx
        ON notifications(source_type, source_id, created_at DESC);

      UPDATE automation_workflow_versions
      SET definition_json = replace(
        definition_json,
        '"send_push_notification"',
        '"create_in_app_notification"'
      )
      WHERE definition_json LIKE '%"send_push_notification"%';

      DROP TABLE IF EXISTS push_delivery_attempts;
      DROP TABLE IF EXISTS push_subscriptions;
      DROP TABLE IF EXISTS push_vapid_keys;
    `,
  },
  {
    version: 45,
    name: "automation_workflow_layouts",
    sql: `
      CREATE TABLE automation_workflow_layouts (
        workflow_id TEXT PRIMARY KEY
          REFERENCES automation_workflows(id) ON DELETE CASCADE,
        positions_json TEXT NOT NULL DEFAULT '{}',
        updated_by TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 46,
    name: "single_current_automation_definition",
    sql: `
      ALTER TABLE automation_runs ADD COLUMN definition_json TEXT;

      UPDATE automation_runs
      SET definition_json = COALESCE(
        (
          SELECT version.definition_json
          FROM automation_workflow_versions AS version
          WHERE version.workflow_id = automation_runs.workflow_id
            AND version.version = automation_runs.workflow_version
        ),
        (
          SELECT current.definition_json
          FROM automation_workflows AS workflow
          JOIN automation_workflow_versions AS current
            ON current.workflow_id = workflow.id
           AND current.version = workflow.current_version
          WHERE workflow.id = automation_runs.workflow_id
        )
      )
      WHERE status IN ('queued', 'running', 'waiting', 'paused');

      UPDATE automation_workflow_versions
      SET
        definition_json = COALESCE(
          (
            SELECT current.definition_json
            FROM automation_workflows AS workflow
            JOIN automation_workflow_versions AS current
              ON current.workflow_id = workflow.id
             AND current.version = workflow.current_version
            WHERE workflow.id = automation_workflow_versions.workflow_id
          ),
          definition_json
        ),
        created_by = COALESCE(
          (
            SELECT current.created_by
            FROM automation_workflows AS workflow
            JOIN automation_workflow_versions AS current
              ON current.workflow_id = workflow.id
             AND current.version = workflow.current_version
            WHERE workflow.id = automation_workflow_versions.workflow_id
          ),
          created_by
        ),
        created_at = COALESCE(
          (
            SELECT current.created_at
            FROM automation_workflows AS workflow
            JOIN automation_workflow_versions AS current
              ON current.workflow_id = workflow.id
             AND current.version = workflow.current_version
            WHERE workflow.id = automation_workflow_versions.workflow_id
          ),
          created_at
        )
      WHERE version = 1;

      UPDATE automation_runs SET workflow_version = 1;
      DELETE FROM automation_workflow_versions WHERE version <> 1;
      UPDATE automation_workflows SET current_version = 1;
    `,
  },
  {
    version: 47,
    name: "monotonic_ticket_event_cursor",
    sql: `
      ALTER TABLE ticket_events ADD COLUMN ingestion_sequence INTEGER;

      UPDATE ticket_events
      SET ingestion_sequence = rowid;

      CREATE UNIQUE INDEX ticket_events_ingestion_sequence_idx
        ON ticket_events(ingestion_sequence)
        WHERE ingestion_sequence IS NOT NULL;

      CREATE TABLE ticket_event_sequence (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        last_value INTEGER NOT NULL CHECK (last_value >= 0)
      ) STRICT;

      INSERT INTO ticket_event_sequence (singleton, last_value)
      SELECT 1, COALESCE(MAX(ingestion_sequence), 0)
      FROM ticket_events;

      ALTER TABLE automation_event_cursors
        ADD COLUMN event_sequence INTEGER NOT NULL DEFAULT 0;

      UPDATE automation_event_cursors
      SET event_sequence = COALESCE(
        (
          SELECT event.ingestion_sequence
          FROM ticket_events AS event
          WHERE event.id = automation_event_cursors.event_id
        ),
        (SELECT MAX(event.ingestion_sequence) FROM ticket_events AS event),
        0
      );
    `,
  },
  {
    version: 48,
    name: "automation_activation_sequence",
    sql: `
      ALTER TABLE automation_workflows
        ADD COLUMN activation_event_sequence INTEGER;

      UPDATE automation_workflows AS workflow
      SET activation_event_sequence = COALESCE(
        (
          SELECT MIN(source_event.ingestion_sequence) - 1
          FROM automation_runs AS run
          JOIN automation_events AS event ON event.id = run.event_id
          JOIN ticket_events AS source_event
            ON source_event.id = json_extract(event.payload_json, '$.sourceEventId')
          WHERE run.workflow_id = workflow.id
            AND json_extract(run.input_json, '$.dryRun') IS NOT 1
            AND source_event.ingestion_sequence IS NOT NULL
        ),
        (SELECT last_value FROM ticket_event_sequence WHERE singleton = 1),
        0
      )
      WHERE workflow.status = 'active';

      ALTER TABLE automation_event_cursors
        ADD COLUMN reconciled_event_sequence INTEGER NOT NULL DEFAULT 0;

      UPDATE automation_event_cursors
      SET reconciled_event_sequence = COALESCE(
        (
          SELECT MIN(workflow.activation_event_sequence)
          FROM automation_workflows AS workflow
          WHERE workflow.status = 'active'
            AND workflow.activation_event_sequence IS NOT NULL
        ),
        event_sequence
      );
    `,
  },
  {
    version: 49,
    name: "remove_persisted_automation_dry_runs",
    sql: `
      DELETE FROM automation_runs
      WHERE json_extract(input_json, '$.dryRun') IS 1;
    `,
  },
  {
    version: 50,
    name: "workspace_threadmark_ai",
    sql: `
      ALTER TABLE investigation_thread_tool_executions
        RENAME TO investigation_thread_tool_executions_v49;
      ALTER TABLE investigation_thread_jobs
        RENAME TO investigation_thread_jobs_v49;
      ALTER TABLE investigation_thread_messages
        RENAME TO investigation_thread_messages_v49;
      ALTER TABLE investigation_threads
        RENAME TO investigation_threads_v49;

      CREATE TABLE investigation_threads (
        id TEXT PRIMARY KEY,
        ticket_id TEXT UNIQUE REFERENCES tickets(id) ON DELETE CASCADE,
        scope TEXT NOT NULL DEFAULT 'ticket'
          CHECK (scope IN ('ticket', 'workspace')),
        title TEXT NOT NULL DEFAULT 'Nova conversa',
        context_json TEXT NOT NULL DEFAULT '{}',
        created_by TEXT,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'concluded')),
        summary TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (
          (scope = 'ticket' AND ticket_id IS NOT NULL)
          OR (scope = 'workspace' AND ticket_id IS NULL)
        )
      ) STRICT;

      CREATE TABLE investigation_thread_messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES investigation_threads(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('operator', 'assistant')),
        body TEXT NOT NULL,
        phase TEXT
          CHECK (phase IS NULL OR phase IN ('analysis', 'needs_information', 'conclusion')),
        evidence_json TEXT NOT NULL DEFAULT '[]',
        suggested_response TEXT,
        next_action TEXT,
        context_json TEXT NOT NULL DEFAULT '{}',
        client_message_id TEXT,
        job_id TEXT UNIQUE,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE investigation_thread_jobs (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES investigation_threads(id) ON DELETE CASCADE,
        operator_message_id TEXT NOT NULL
          REFERENCES investigation_thread_messages(id) ON DELETE RESTRICT,
        assistant_message_id TEXT
          REFERENCES investigation_thread_messages(id) ON DELETE SET NULL,
        state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'failed')),
        requested_at TEXT NOT NULL,
        started_at TEXT,
        claimed_at TEXT,
        lease_expires_at TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        finished_at TEXT,
        result_json TEXT,
        error TEXT,
        ai_provider_id TEXT,
        ai_connection_id TEXT,
        ai_model TEXT,
        cancelled_at TEXT,
        cancelled_by TEXT,
        UNIQUE(thread_id, operator_message_id)
      ) STRICT;

      CREATE TABLE investigation_thread_tool_executions (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL
          REFERENCES investigation_thread_jobs(id) ON DELETE CASCADE,
        request_id TEXT NOT NULL,
        tool_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        operation TEXT NOT NULL,
        arguments_json TEXT NOT NULL,
        purpose TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('success', 'error')),
        summary TEXT NOT NULL,
        content TEXT NOT NULL,
        reference TEXT,
        executed_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        UNIQUE(job_id, request_id)
      ) STRICT;

      INSERT INTO investigation_threads (
        id, ticket_id, scope, title, context_json, created_by, status,
        summary, created_at, updated_at
      )
      SELECT id, ticket_id, 'ticket', 'Ticket', '{}', NULL, status,
             summary, created_at, updated_at
      FROM investigation_threads_v49;

      INSERT INTO investigation_thread_messages (
        id, thread_id, role, body, phase, evidence_json, suggested_response,
        next_action, context_json, client_message_id, job_id, created_at
      )
      SELECT id, thread_id, role, body, phase, evidence_json,
             suggested_response, next_action, '{}', client_message_id, job_id,
             created_at
      FROM investigation_thread_messages_v49;

      INSERT INTO investigation_thread_jobs (
        id, thread_id, operator_message_id, assistant_message_id, state,
        requested_at, started_at, claimed_at, lease_expires_at, attempt_count,
        finished_at, result_json, error, ai_provider_id, ai_connection_id,
        ai_model, cancelled_at, cancelled_by
      )
      SELECT id, thread_id, operator_message_id, assistant_message_id, state,
             requested_at, started_at, claimed_at, lease_expires_at,
             attempt_count, finished_at, result_json, error, ai_provider_id,
             ai_connection_id, ai_model, cancelled_at, cancelled_by
      FROM investigation_thread_jobs_v49;

      INSERT INTO investigation_thread_tool_executions (
        id, job_id, request_id, tool_id, tool_name, operation, arguments_json,
        purpose, status, summary, content, reference, executed_at, recorded_at
      )
      SELECT id, job_id, request_id, tool_id, tool_name, operation,
             arguments_json, purpose, status, summary, content, reference,
             executed_at, recorded_at
      FROM investigation_thread_tool_executions_v49;

      DROP TABLE investigation_thread_tool_executions_v49;
      DROP TABLE investigation_thread_jobs_v49;
      DROP TABLE investigation_thread_messages_v49;
      DROP TABLE investigation_threads_v49;

      CREATE INDEX investigation_threads_scope_updated_idx
        ON investigation_threads(scope, updated_at DESC, id);
      CREATE INDEX investigation_thread_messages_time_idx
        ON investigation_thread_messages(thread_id, created_at, id);
      CREATE UNIQUE INDEX investigation_thread_messages_client_id_idx
        ON investigation_thread_messages(thread_id, client_message_id)
        WHERE client_message_id IS NOT NULL;
      CREATE UNIQUE INDEX investigation_thread_jobs_active_idx
        ON investigation_thread_jobs(thread_id)
        WHERE state IN ('queued', 'running');
      CREATE INDEX investigation_thread_jobs_queue_idx
        ON investigation_thread_jobs(state, requested_at);
      CREATE INDEX investigation_thread_jobs_cancelled_idx
        ON investigation_thread_jobs(thread_id, cancelled_at DESC)
        WHERE cancelled_at IS NOT NULL;
      CREATE INDEX investigation_thread_tool_executions_job_time_idx
        ON investigation_thread_tool_executions(job_id, executed_at, id);

      CREATE TRIGGER investigation_thread_tool_executions_no_update
      BEFORE UPDATE ON investigation_thread_tool_executions
      BEGIN
        SELECT RAISE(ABORT, 'tool execution audit is append-only');
      END;
    `,
  },
  {
    version: 51,
    name: "threadmark_ai_image_attachments",
    sql: `
      CREATE TABLE investigation_thread_message_attachments (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL
          REFERENCES investigation_thread_messages(id) ON DELETE CASCADE,
        kind TEXT NOT NULL DEFAULT 'image' CHECK (kind = 'image'),
        mime_type TEXT NOT NULL
          CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/gif', 'image/webp')),
        file_name TEXT NOT NULL,
        local_path TEXT NOT NULL UNIQUE,
        size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
        sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
        ai_analysis_approved INTEGER NOT NULL DEFAULT 0
          CHECK (ai_analysis_approved IN (0, 1)),
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX investigation_thread_message_attachments_message_idx
        ON investigation_thread_message_attachments(message_id, created_at, id);
    `,
  },
  {
    version: 52,
    name: "cancelled_ticket_status",
    disableForeignKeys: true,
    sql: `
      PRAGMA legacy_alter_table = ON;

      ALTER TABLE tickets RENAME TO tickets_v51;

      CREATE TABLE tickets (
        number INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
        group_id TEXT NOT NULL REFERENCES whatsapp_groups(id) ON DELETE RESTRICT,
        affected_store_id TEXT REFERENCES client_stores(id) ON DELETE SET NULL,
        source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'new'
          CHECK (status IN ('new', 'triage', 'in_progress', 'waiting_customer', 'blocked', 'resolved', 'cancelled', 'archived')),
        priority TEXT NOT NULL DEFAULT 'normal'
          CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
        confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
        needs_review INTEGER NOT NULL DEFAULT 1 CHECK (needs_review IN (0, 1)),
        ai_relation TEXT
          CHECK (ai_relation IS NULL OR ai_relation IN ('new', 'continuation', 'possible_reopen', 'informational', 'social', 'uncertain')),
        next_action TEXT,
        first_message_at TEXT NOT NULL,
        last_message_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resolved_at TEXT,
        archived_at TEXT,
        merged_into_ticket_id TEXT REFERENCES tickets(id) ON DELETE SET NULL,
        requester_id TEXT REFERENCES participants(id) ON DELETE SET NULL,
        assignee_user_id TEXT REFERENCES local_users(id) ON DELETE SET NULL
      ) STRICT;

      INSERT INTO tickets (
        number, id, client_id, group_id, affected_store_id, source_message_id,
        title, summary, status, priority, confidence, needs_review, ai_relation,
        next_action, first_message_at, last_message_at, created_at, updated_at,
        resolved_at, archived_at, merged_into_ticket_id, requester_id,
        assignee_user_id
      )
      SELECT
        number, id, client_id, group_id, affected_store_id, source_message_id,
        title, summary, status, priority, confidence, needs_review, ai_relation,
        next_action, first_message_at, last_message_at, created_at, updated_at,
        resolved_at, archived_at, merged_into_ticket_id, requester_id,
        assignee_user_id
      FROM tickets_v51;

      DROP TABLE tickets_v51;

      CREATE INDEX tickets_status_updated_idx
        ON tickets(status, updated_at DESC);
      CREATE INDEX tickets_client_updated_idx
        ON tickets(client_id, updated_at DESC);
      CREATE UNIQUE INDEX tickets_source_message_idx
        ON tickets(source_message_id)
        WHERE source_message_id IS NOT NULL;
      CREATE INDEX tickets_merged_into_idx
        ON tickets(merged_into_ticket_id)
        WHERE merged_into_ticket_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS ticket_messages_message_idx
        ON ticket_messages(message_id, ticket_id);
      CREATE INDEX tickets_group_status_idx
        ON tickets(group_id, status, last_message_at DESC);
      CREATE INDEX tickets_requester_updated_idx
        ON tickets(requester_id, updated_at DESC);
      CREATE INDEX tickets_assignee_status_updated_idx
        ON tickets(assignee_user_id, status, updated_at DESC);

      PRAGMA legacy_alter_table = OFF;
    `,
  },
  {
    version: 53,
    name: "connected_apps_threadmark_ai_authorization",
    sql: `
      ALTER TABLE connected_apps
        ADD COLUMN ai_enabled INTEGER NOT NULL DEFAULT 0
          CHECK (ai_enabled IN (0, 1));

      CREATE INDEX connected_apps_ai_enabled_name_idx
        ON connected_apps(ai_enabled DESC, enabled DESC, name COLLATE NOCASE, id);
    `,
  },
  {
    version: 54,
    name: "threadmark_ai_ticket_drafts",
    sql: `
      CREATE TABLE threadmark_ai_ticket_drafts (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL
          REFERENCES investigation_threads(id) ON DELETE CASCADE,
        operator_message_id TEXT NOT NULL
          REFERENCES investigation_thread_messages(id) ON DELETE RESTRICT,
        group_id TEXT NOT NULL REFERENCES whatsapp_groups(id) ON DELETE RESTRICT,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        priority TEXT NOT NULL DEFAULT 'normal'
          CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
        external_source_type TEXT
          CHECK (external_source_type IS NULL OR external_source_type = 'intercom_conversation'),
        external_source_id TEXT,
        state TEXT NOT NULL DEFAULT 'pending'
          CHECK (state IN ('pending', 'created')),
        created_ticket_id TEXT UNIQUE REFERENCES tickets(id) ON DELETE SET NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (
          (external_source_type IS NULL AND external_source_id IS NULL)
          OR (external_source_type IS NOT NULL AND external_source_id IS NOT NULL)
        )
      ) STRICT;

      CREATE INDEX threadmark_ai_ticket_drafts_thread_time_idx
        ON threadmark_ai_ticket_drafts(thread_id, created_at DESC, id);
      CREATE INDEX threadmark_ai_ticket_drafts_source_idx
        ON threadmark_ai_ticket_drafts(external_source_type, external_source_id)
        WHERE external_source_id IS NOT NULL;
    `,
  },
  {
    version: 55,
    name: "native_intercom_connected_app",
    disableForeignKeys: true,
    sql: `
      ALTER TABLE connected_apps RENAME TO connected_apps_v54;

      CREATE TABLE connected_apps (
        id TEXT PRIMARY KEY,
        provider_type TEXT NOT NULL
          CHECK (provider_type IN ('slack_webhook', 'intercom', 'custom_http')),
        name TEXT NOT NULL,
        description TEXT,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        config_json TEXT NOT NULL DEFAULT '{}',
        secret_ref TEXT,
        secret_configured INTEGER NOT NULL DEFAULT 0
          CHECK (secret_configured IN (0, 1)),
        last_tested_at TEXT,
        last_test_status TEXT
          CHECK (last_test_status IS NULL OR last_test_status IN ('success', 'failed')),
        last_test_message TEXT,
        created_by TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        ai_enabled INTEGER NOT NULL DEFAULT 0 CHECK (ai_enabled IN (0, 1))
      ) STRICT;

      INSERT INTO connected_apps (
        id, provider_type, name, description, enabled, config_json,
        secret_ref, secret_configured, last_tested_at, last_test_status,
        last_test_message, created_by, updated_by, created_at, updated_at, ai_enabled
      )
      SELECT
        id,
        CASE
          WHEN provider_type = 'custom_http'
            AND lower(json_extract(config_json, '$.endpoint')) GLOB 'https://api.intercom.io/*'
            THEN 'intercom'
          WHEN provider_type = 'custom_http'
            AND lower(json_extract(config_json, '$.endpoint')) GLOB 'https://api.eu.intercom.io/*'
            THEN 'intercom'
          WHEN provider_type = 'custom_http'
            AND lower(json_extract(config_json, '$.endpoint')) GLOB 'https://api.au.intercom.io/*'
            THEN 'intercom'
          ELSE provider_type
        END,
        name,
        description,
        enabled,
        CASE
          WHEN lower(json_extract(config_json, '$.endpoint')) GLOB 'https://api.eu.intercom.io/*'
            THEN json_set(config_json, '$.endpoint', 'https://api.eu.intercom.io/', '$.endpointPreview', 'https://api.eu.intercom.io/')
          WHEN lower(json_extract(config_json, '$.endpoint')) GLOB 'https://api.au.intercom.io/*'
            THEN json_set(config_json, '$.endpoint', 'https://api.au.intercom.io/', '$.endpointPreview', 'https://api.au.intercom.io/')
          WHEN lower(json_extract(config_json, '$.endpoint')) GLOB 'https://api.intercom.io/*'
            THEN json_set(config_json, '$.endpoint', 'https://api.intercom.io/', '$.endpointPreview', 'https://api.intercom.io/')
          ELSE config_json
        END,
        secret_ref,
        secret_configured,
        last_tested_at,
        last_test_status,
        last_test_message,
        created_by,
        updated_by,
        created_at,
        updated_at,
        ai_enabled
      FROM connected_apps_v54;

      DROP TABLE connected_apps_v54;

      CREATE INDEX connected_apps_enabled_name_idx
        ON connected_apps(enabled DESC, name COLLATE NOCASE, id);
      CREATE INDEX connected_apps_ai_enabled_name_idx
        ON connected_apps(ai_enabled DESC, enabled DESC, name COLLATE NOCASE, id);
    `,
  },
  {
    version: 56,
    name: "threadmark_ai_automation_proposals",
    sql: `
      ALTER TABLE investigation_thread_messages
        ADD COLUMN actor_user_id TEXT
          REFERENCES local_users(id) ON DELETE SET NULL;
      ALTER TABLE investigation_thread_messages
        ADD COLUMN actor_role TEXT
          CHECK (actor_role IS NULL OR actor_role IN ('owner', 'admin', 'operator', 'viewer'));

      CREATE TABLE threadmark_ai_automation_drafts (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL
          REFERENCES investigation_threads(id) ON DELETE CASCADE,
        operator_message_id TEXT NOT NULL
          REFERENCES investigation_thread_messages(id) ON DELETE RESTRICT,
        intent TEXT NOT NULL CHECK (intent IN ('create', 'update')),
        target_workflow_id TEXT,
        name TEXT NOT NULL,
        description TEXT,
        definition_json TEXT NOT NULL,
        base_updated_at TEXT,
        state TEXT NOT NULL DEFAULT 'pending'
          CHECK (state IN ('pending', 'applied')),
        applied_workflow_id TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (
          (intent = 'create' AND target_workflow_id IS NULL AND base_updated_at IS NULL)
          OR (intent = 'update' AND target_workflow_id IS NOT NULL AND base_updated_at IS NOT NULL)
        )
      ) STRICT;

      CREATE INDEX threadmark_ai_automation_drafts_thread_time_idx
        ON threadmark_ai_automation_drafts(thread_id, created_at DESC, id);
      CREATE INDEX threadmark_ai_automation_drafts_target_idx
        ON threadmark_ai_automation_drafts(target_workflow_id, created_at DESC)
        WHERE target_workflow_id IS NOT NULL;
    `,
  },
  {
    version: 57,
    name: "remote_mcp_connected_apps",
    disableForeignKeys: true,
    sql: `
      ALTER TABLE connected_apps RENAME TO connected_apps_v56;

      CREATE TABLE connected_apps (
        id TEXT PRIMARY KEY,
        provider_type TEXT NOT NULL
          CHECK (provider_type IN ('slack_webhook', 'intercom', 'custom_http', 'mcp_remote')),
        name TEXT NOT NULL,
        description TEXT,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        config_json TEXT NOT NULL DEFAULT '{}',
        secret_ref TEXT,
        secret_configured INTEGER NOT NULL DEFAULT 0
          CHECK (secret_configured IN (0, 1)),
        last_tested_at TEXT,
        last_test_status TEXT
          CHECK (last_test_status IS NULL OR last_test_status IN ('success', 'failed')),
        last_test_message TEXT,
        created_by TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        ai_enabled INTEGER NOT NULL DEFAULT 0 CHECK (ai_enabled IN (0, 1))
      ) STRICT;

      INSERT INTO connected_apps (
        id, provider_type, name, description, enabled, config_json,
        secret_ref, secret_configured, last_tested_at, last_test_status,
        last_test_message, created_by, updated_by, created_at, updated_at, ai_enabled
      )
      SELECT
        id, provider_type, name, description, enabled, config_json,
        secret_ref, secret_configured, last_tested_at, last_test_status,
        last_test_message, created_by, updated_by, created_at, updated_at, ai_enabled
      FROM connected_apps_v56;

      DROP TABLE connected_apps_v56;

      CREATE INDEX connected_apps_enabled_name_idx
        ON connected_apps(enabled DESC, name COLLATE NOCASE, id);
      CREATE INDEX connected_apps_ai_enabled_name_idx
        ON connected_apps(ai_enabled DESC, enabled DESC, name COLLATE NOCASE, id);
    `,
  },
  {
    version: 58,
    name: "threadmark_ai_ticket_categories_and_updates",
    sql: `
      ALTER TABLE threadmark_ai_ticket_drafts
        ADD COLUMN category_ids_json TEXT NOT NULL DEFAULT '[]'
          CHECK (json_valid(category_ids_json) AND json_type(category_ids_json) = 'array');

      CREATE TABLE threadmark_ai_ticket_update_drafts (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL
          REFERENCES investigation_threads(id) ON DELETE CASCADE,
        operator_message_id TEXT NOT NULL
          REFERENCES investigation_thread_messages(id) ON DELETE RESTRICT,
        ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        title TEXT,
        summary TEXT,
        priority TEXT CHECK (priority IS NULL OR priority IN ('low', 'normal', 'high', 'urgent')),
        add_category_ids_json TEXT NOT NULL DEFAULT '[]'
          CHECK (json_valid(add_category_ids_json) AND json_type(add_category_ids_json) = 'array'),
        remove_category_ids_json TEXT NOT NULL DEFAULT '[]'
          CHECK (json_valid(remove_category_ids_json) AND json_type(remove_category_ids_json) = 'array'),
        base_updated_at TEXT NOT NULL,
        base_category_ids_json TEXT NOT NULL DEFAULT '[]'
          CHECK (json_valid(base_category_ids_json) AND json_type(base_category_ids_json) = 'array'),
        state TEXT NOT NULL DEFAULT 'pending'
          CHECK (state IN ('pending', 'applied')),
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX threadmark_ai_ticket_update_drafts_thread_time_idx
        ON threadmark_ai_ticket_update_drafts(thread_id, created_at DESC, id);
      CREATE INDEX threadmark_ai_ticket_update_drafts_ticket_time_idx
        ON threadmark_ai_ticket_update_drafts(ticket_id, created_at DESC, id);
    `,
  },
  {
    version: 59,
    name: "repair_automatic_group_client_names",
    sql: `
      UPDATE clients AS client
      SET name = (
            SELECT conversation.subject
            FROM whatsapp_groups conversation
            WHERE conversation.client_id = client.id
              AND conversation.client_link_source = 'fallback'
              AND trim(conversation.subject) <> ''
              AND lower(trim(conversation.subject)) NOT IN (
                lower(trim(conversation.external_jid)),
                lower(substr(conversation.external_jid, 1, instr(conversation.external_jid, '@') - 1)),
                'grupo ' || lower(substr(conversation.external_jid, 1, instr(conversation.external_jid, '@') - 1))
              )
            ORDER BY conversation.updated_at DESC, conversation.id
            LIMIT 1
          ),
          updated_at = (
            SELECT conversation.updated_at
            FROM whatsapp_groups conversation
            WHERE conversation.client_id = client.id
              AND conversation.client_link_source = 'fallback'
            ORDER BY conversation.updated_at DESC, conversation.id
            LIMIT 1
          )
      WHERE client.manual_override = 0
        AND EXISTS (
          SELECT 1
          FROM whatsapp_groups conversation
          WHERE conversation.client_id = client.id
            AND conversation.client_link_source = 'fallback'
            AND trim(conversation.subject) <> ''
            AND lower(trim(client.name)) IN (
              lower(trim(conversation.external_jid)),
              lower(substr(conversation.external_jid, 1, instr(conversation.external_jid, '@') - 1)),
              'grupo ' || lower(substr(conversation.external_jid, 1, instr(conversation.external_jid, '@') - 1))
            )
            AND lower(trim(conversation.subject)) NOT IN (
              lower(trim(conversation.external_jid)),
              lower(substr(conversation.external_jid, 1, instr(conversation.external_jid, '@') - 1)),
              'grupo ' || lower(substr(conversation.external_jid, 1, instr(conversation.external_jid, '@') - 1))
            )
        );
    `,
  },
  {
    version: 60,
    name: "remove_whatsapp_system_stub_messages",
    sql: `
      CREATE TEMP TABLE threadmark_system_stub_message_ids (
        id TEXT PRIMARY KEY
      ) WITHOUT ROWID;

      INSERT INTO threadmark_system_stub_message_ids (id)
      SELECT id
      FROM messages
      WHERE message_type = 'system'
        AND json_valid(raw_json)
        AND json_extract(raw_json, '$.messageStubType') IS NOT NULL;

      CREATE TEMP TABLE threadmark_system_stub_block_ids (
        id TEXT PRIMARY KEY
      ) WITHOUT ROWID;
      INSERT INTO threadmark_system_stub_block_ids (id)
      SELECT DISTINCT block_id
      FROM triage_block_messages
      WHERE message_id IN (SELECT id FROM threadmark_system_stub_message_ids);

      CREATE TEMP TABLE threadmark_system_stub_job_ids (
        id TEXT PRIMARY KEY
      ) WITHOUT ROWID;
      INSERT INTO threadmark_system_stub_job_ids (id)
      SELECT DISTINCT job_id
      FROM triage_ai_job_messages
      WHERE message_id IN (SELECT id FROM threadmark_system_stub_message_ids);

      DELETE FROM ticket_messages
      WHERE message_id IN (SELECT id FROM threadmark_system_stub_message_ids);
      DELETE FROM triage_block_messages
      WHERE message_id IN (SELECT id FROM threadmark_system_stub_message_ids);
      DELETE FROM triage_ai_job_messages
      WHERE message_id IN (SELECT id FROM threadmark_system_stub_message_ids);
      DELETE FROM messages
      WHERE id IN (SELECT id FROM threadmark_system_stub_message_ids);

      DELETE FROM triage_blocks
      WHERE id IN (SELECT id FROM threadmark_system_stub_block_ids)
        AND NOT EXISTS (
          SELECT 1 FROM triage_block_messages
          WHERE triage_block_messages.block_id = triage_blocks.id
        );
      DELETE FROM triage_ai_jobs
      WHERE id IN (SELECT id FROM threadmark_system_stub_job_ids)
        AND NOT EXISTS (
          SELECT 1 FROM triage_ai_job_messages
          WHERE triage_ai_job_messages.job_id = triage_ai_jobs.id
        );

      DROP TABLE threadmark_system_stub_job_ids;
      DROP TABLE threadmark_system_stub_block_ids;
      DROP TABLE threadmark_system_stub_message_ids;
    `,
  },
  {
    version: 61,
    name: "threadmark_ai_ticket_source_messages",
    sql: `
      ALTER TABLE threadmark_ai_ticket_drafts
        ADD COLUMN message_ids_json TEXT NOT NULL DEFAULT '[]'
          CHECK (json_valid(message_ids_json) AND json_type(message_ids_json) = 'array');

      ALTER TABLE threadmark_ai_ticket_drafts
        ADD COLUMN source_messages_json TEXT NOT NULL DEFAULT '[]'
          CHECK (json_valid(source_messages_json) AND json_type(source_messages_json) = 'array');

      CREATE TABLE ticket_external_messages (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        source_type TEXT NOT NULL,
        source_conversation_id TEXT NOT NULL,
        external_message_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        author_role TEXT NOT NULL CHECK (author_role IN ('customer', 'support')),
        body TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        position INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(ticket_id, source_type, source_conversation_id, external_message_id)
      ) STRICT;

      CREATE INDEX ticket_external_messages_ticket_time_idx
        ON ticket_external_messages(ticket_id, occurred_at, position, id);
    `,
  },
  {
    version: 62,
    name: "automation_capacity_assignment_queue",
    sql: `
      CREATE TABLE automation_assignment_queue (
        step_id TEXT PRIMARY KEY
          REFERENCES automation_run_steps(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL
          REFERENCES automation_runs(id) ON DELETE CASCADE,
        workflow_id TEXT NOT NULL
          REFERENCES automation_workflows(id) ON DELETE CASCADE,
        node_id TEXT NOT NULL,
        ticket_id TEXT NOT NULL
          REFERENCES tickets(id) ON DELETE CASCADE,
        queued_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(run_id, node_id)
      ) STRICT;

      CREATE INDEX automation_assignment_queue_order_idx
        ON automation_assignment_queue(workflow_id, node_id, queued_at, step_id);
      CREATE INDEX automation_assignment_queue_ticket_idx
        ON automation_assignment_queue(ticket_id, queued_at, step_id);
    `,
  },
  {
    version: 63,
    name: "automation_capacity_assignment_fifo_order",
    sql: `
      ALTER TABLE automation_assignment_queue
        ADD COLUMN queue_order INTEGER;

      UPDATE automation_assignment_queue
      SET queue_order = rowid
      WHERE queue_order IS NULL;

      CREATE UNIQUE INDEX automation_assignment_queue_fifo_idx
        ON automation_assignment_queue(queue_order);
    `,
  },
  {
    version: 64,
    name: "automation_capacity_assignment_scoped_fifo",
    sql: `
      DROP INDEX IF EXISTS automation_assignment_queue_fifo_idx;

      CREATE INDEX automation_assignment_queue_fifo_idx
        ON automation_assignment_queue(workflow_id, node_id, queue_order, step_id);
    `,
  },
  {
    version: 65,
    name: "threadmark_ai_ticket_update_source_messages",
    sql: `
      ALTER TABLE threadmark_ai_ticket_update_drafts
        ADD COLUMN message_ids_json TEXT NOT NULL DEFAULT '[]'
          CHECK (json_valid(message_ids_json) AND json_type(message_ids_json) = 'array');

      ALTER TABLE threadmark_ai_ticket_update_drafts
        ADD COLUMN source_messages_json TEXT NOT NULL DEFAULT '[]'
          CHECK (json_valid(source_messages_json) AND json_type(source_messages_json) = 'array');

      ALTER TABLE threadmark_ai_ticket_update_drafts
        ADD COLUMN external_source_type TEXT
          CHECK (external_source_type IS NULL OR external_source_type = 'intercom_conversation');

      ALTER TABLE threadmark_ai_ticket_update_drafts
        ADD COLUMN external_source_id TEXT;
    `,
  },
];
