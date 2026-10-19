import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  ChannelConfig, ChannelConnection, ChannelEventRecord, ChannelMessageEvent, ChannelWriteInput,
} from "../../shared/channels.js";
import type { SupportDatabase } from "../db/index.js";
import { DomainError, NotFoundError, ValidationError } from "../domain/errors.js";
import type { SupportStore } from "../domain/support-store.js";
import type { LocalSecretVault } from "../runtime/secret-vault.js";
import { channelWriteSchema, normalizeChannelEvent } from "./normalize.js";

interface ConnectionRow {
  id: string; name: string; description: string; status: ChannelConnection["status"];
  client_id: string | null; config_json: string; token_digest: string;
  signature_secret_ref: string | null; last_received_at: string | null; last_error: string | null;
  last_preview_at: string | null; preview_config_hash: string | null;
  created_at: string; updated_at: string;
}
interface EventRow {
  id: string; connection_id: string; external_event_id: string; payload_json: string;
  config_json: string; state: ChannelEventRecord["state"]; attempts: number;
  error_code: string | null; received_at: string; processed_at: string | null;
}
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function equal(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function stableId(...parts: string[]): string { return `channel:${digest(JSON.stringify(parts))}`; }

export class ChannelService {
  readonly database: SupportDatabase;
  constructor(private readonly store: SupportStore, private readonly vault: Pick<LocalSecretVault, "set" | "get">) {
    this.database = store.database;
  }

  list(): ChannelConnection[] {
    return (this.database.prepare("SELECT * FROM channel_connections ORDER BY name COLLATE NOCASE, id").all() as ConnectionRow[])
      .map((row) => this.dto(row));
  }
  get(id: string): ChannelConnection { return this.dto(this.row(id)); }

  async create(input: ChannelWriteInput, actor: string): Promise<{ connection: ChannelConnection; token: string | null }> {
    const parsed = channelWriteSchema.parse(input);
    this.validateClient(parsed.clientId);
    if (parsed.config.authentication !== "bearer" && !parsed.signatureSecret) throw new ValidationError("Informe uma chave de assinatura com pelo menos 32 caracteres.");
    const id = randomUUID(); const token = parsed.bearerToken ?? randomBytes(32).toString("base64url"); const now = new Date().toISOString();
    const secretRef = parsed.signatureSecret ? `channel:${id}:signature` : null;
    if (secretRef && parsed.signatureSecret) await this.vault.set(secretRef, parsed.signatureSecret);
    this.database.prepare(`INSERT INTO channel_connections
      (id,name,description,client_id,config_json,token_digest,signature_secret_ref,created_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id,parsed.name,parsed.description,parsed.clientId ?? null,
        JSON.stringify(parsed.config),digest(token),secretRef,actor,now,now);
    return {connection:this.get(id), token:parsed.config.authentication === "bearer" ? token : null};
  }

  async update(id: string, input: ChannelWriteInput): Promise<ChannelConnection> {
    const row = this.row(id); const parsed = channelWriteSchema.parse(input); this.validateClient(parsed.clientId);
    let secretRef = row.signature_secret_ref;
    if (parsed.signatureSecret) {
      secretRef = `channel:${id}:signature`; await this.vault.set(secretRef, parsed.signatureSecret);
    }
    if (parsed.config.authentication !== "bearer" && !secretRef) throw new ValidationError("Configure a chave de assinatura.");
    this.database.prepare(`UPDATE channel_connections SET name=?,description=?,client_id=?,config_json=?,signature_secret_ref=?,token_digest=COALESCE(?,token_digest),
      status='draft',last_preview_at=NULL,preview_config_hash=NULL,updated_at=? WHERE id=?`)
      .run(parsed.name,parsed.description,parsed.clientId ?? null,JSON.stringify(parsed.config),secretRef,
        parsed.bearerToken ? digest(parsed.bearerToken) : null,new Date().toISOString(),id);
    return this.get(id);
  }

  preview(id: string, payload: unknown): ChannelMessageEvent {
    const row = this.row(id); const event = normalizeChannelEvent(payload, JSON.parse(row.config_json));
    const now = new Date().toISOString();
    this.database.prepare("UPDATE channel_connections SET last_preview_at=?,preview_config_hash=?,updated_at=? WHERE id=?")
      .run(now,digest(row.config_json),now,id);
    return event;
  }

  setStatus(id: string, status: ChannelConnection["status"]): ChannelConnection {
    const row = this.row(id);
    if (status === "active" && row.preview_config_hash !== digest(row.config_json)) throw new ValidationError("Teste uma mensagem com a configuração atual antes de ativar.");
    this.database.transaction(() => {
      this.database.prepare("UPDATE channel_connections SET status=?,updated_at=? WHERE id=?").run(status,new Date().toISOString(),id);
      // Existing messages keep their triage decisions; pausing only gates ingestion/processing.
    })();
    return this.get(id);
  }

  rotateToken(id: string): string {
    const row = this.row(id);
    if (JSON.parse(row.config_json).authentication !== "bearer") throw new ValidationError("Este canal utiliza assinatura.");
    const token = randomBytes(32).toString("base64url");
    this.database.prepare("UPDATE channel_connections SET token_digest=?,updated_at=? WHERE id=?").run(digest(token),new Date().toISOString(),id);
    return token;
  }

  async authenticate(id: string, headers: Headers, body?: string): Promise<void> {
    const row = this.row(id); const config: ChannelConfig = JSON.parse(row.config_json);
    if (row.status !== "active") throw new DomainError("O canal não está ativo.","channel_inactive",409);
    let valid = false;
    if (config.authentication === "bearer") {
      const authorization = headers.get("authorization") ?? "";
      valid = authorization.startsWith("Bearer ") && equal(digest(authorization.slice(7)),row.token_digest);
    } else if (body !== undefined && row.signature_secret_ref) {
      const secret = await this.vault.get(row.signature_secret_ref);
      const algorithm = config.authentication === "hmac_sha256" ? "sha256" : config.signatureAlgorithm ?? "sha256";
      if (secret) valid = equal(headers.get(config.signatureHeader) ?? "",`${config.signaturePrefix ?? ""}${createHmac(algorithm,secret).update(body).digest(config.signatureEncoding)}`);
    }
    if (!valid) throw new DomainError("Credencial do canal inválida.","channel_unauthorized",401);
  }

  receive(id: string, payload: unknown): { accepted: true; duplicate: boolean; eventId: string } {
    const row = this.row(id);
    if (row.status !== "active") throw new DomainError("O canal não está ativo.","channel_inactive",409);
    const event = normalizeChannelEvent(payload,JSON.parse(row.config_json));
    return this.database.transaction(() => {
      const existing = this.database.prepare("SELECT id FROM channel_events WHERE connection_id=? AND external_event_id=?").get(id,event.eventId) as {id:string} | undefined;
      if (existing) return {accepted:true as const,duplicate:true,eventId:existing.id};
      const count = this.database.prepare("SELECT COUNT(*) AS count FROM channel_events WHERE connection_id=? AND received_at>=?")
        .get(id,new Date(Date.now()-60_000).toISOString()) as {count:number};
      if (count.count >= 1000) throw new DomainError("Limite de recebimento do canal atingido.","channel_rate_limited",429);
      const eventId = randomUUID(); const now = new Date().toISOString();
      this.database.prepare(`INSERT INTO channel_events (id,connection_id,external_event_id,payload_json,config_json,received_at) VALUES (?,?,?,?,?,?)`)
        .run(eventId,id,event.eventId,JSON.stringify(payload),row.config_json,now);
      this.database.prepare("UPDATE channel_connections SET last_received_at=?,updated_at=? WHERE id=?").run(now,now,id);
      return {accepted:true as const,duplicate:false,eventId};
    }).immediate();
  }

  events(id: string): ChannelEventRecord[] {
    this.row(id);
    return (this.database.prepare("SELECT * FROM channel_events WHERE connection_id=? ORDER BY received_at DESC,id DESC LIMIT 50").all(id) as EventRow[])
      .map((row) => ({id:row.id,externalEventId:row.external_event_id,state:row.state,attempts:row.attempts,errorCode:row.error_code,receivedAt:row.received_at,processedAt:row.processed_at}));
  }
  retry(id: string, eventId: string): void {
    const row = this.row(id);
    const event = this.database.prepare("SELECT * FROM channel_events WHERE id=? AND connection_id=?").get(eventId,id) as EventRow | undefined;
    if (!event) throw new NotFoundError("Evento",eventId);
    if (event.state !== "failed") throw new ValidationError("Somente eventos com falha podem ser reprocessados.");
    normalizeChannelEvent(JSON.parse(event.payload_json),JSON.parse(row.config_json));
    this.database.prepare("UPDATE channel_events SET state='pending',error_code=NULL,config_json=? WHERE id=?").run(row.config_json,eventId);
  }

  processPending(limit = 50): number {
    const rows = this.database.prepare(`SELECT event.* FROM channel_events event JOIN channel_connections connection ON connection.id=event.connection_id
      WHERE event.state='pending' AND connection.status='active' ORDER BY event.received_at,event.rowid LIMIT ?`).all(limit) as EventRow[];
    for (const event of rows) {
      try {
        this.database.transaction(() => {
          const claim = this.database.prepare("UPDATE channel_events SET state='processing',attempts=attempts+1 WHERE id=? AND state='pending'").run(event.id);
          if (!claim.changes) return;
          this.applyEvent(event,normalizeChannelEvent(JSON.parse(event.payload_json),JSON.parse(event.config_json)));
          this.database.prepare("UPDATE channel_events SET state='processed',processed_at=?,error_code=NULL WHERE id=?").run(new Date().toISOString(),event.id);
          this.database.prepare("UPDATE channel_connections SET last_error=NULL WHERE id=?").run(event.connection_id);
        }).immediate();
      } catch (error) {
        const code = error instanceof DomainError ? error.code : "channel_processing_failed";
        this.database.prepare("UPDATE channel_events SET state='failed',attempts=attempts+1,error_code=? WHERE id=? AND state='pending'").run(code,event.id);
        this.database.prepare("UPDATE channel_connections SET last_error=? WHERE id=?").run(code,event.connection_id);
      }
    }
    return rows.length;
  }

  private applyEvent(record: EventRow, event: ChannelMessageEvent): void {
    const connection = this.row(record.connection_id); const config: ChannelConfig = JSON.parse(record.config_json);
    const conversationId = stableId(connection.id,event.conversationId,event.threadId ?? "");
    const messageId = stableId(conversationId,event.messageId);
    const previous = this.database.prepare(`SELECT message.*, version.revision_at,version.deleted_at
      FROM messages message JOIN channel_message_versions version ON version.message_id=message.id WHERE message.id=?`).get(messageId) as {
        sender_id:string; occurred_at:string; text:string|null; triage_state:string; message_type:string;
        revision_at:string; deleted_at:string|null;
      } | undefined;
    if (previous && (event.eventType === "message.created" || event.eventOccurredAt <= previous.revision_at)) return;
    if (event.eventType !== "message.created" && !previous) throw new DomainError("A mensagem original ainda não foi recebida.","channel_message_missing",409);
    if (event.eventType === "message.deleted" && previous) {
      this.audit(record,event,messageId,previous.text);
      this.database.prepare("UPDATE messages SET text='[Mensagem excluída na origem]',message_type='system',triage_kind='context',triage_state='context',updated_at=? WHERE id=?")
        .run(new Date().toISOString(),messageId);
      this.database.prepare("UPDATE channel_message_versions SET revision_at=?,deleted_at=?,attachments_json='[]' WHERE message_id=?")
        .run(event.eventOccurredAt,event.eventOccurredAt,messageId);
      this.store.notifyConversationMessageChanged(conversationId);
      return;
    }
    if (previous?.deleted_at) return; // A redacted message cannot be resurrected by a late edit.
    const senderId = previous?.sender_id ?? this.upsertAuthor(connection.id,event);
    this.upsertConversation(connection,event,conversationId,config);
    this.store.addGroupParticipant(conversationId,senderId);
    if (previous) this.audit(record,event,messageId,previous.text);
    this.store.upsertMessage({
      id:messageId,groupId:conversationId,senderId,externalId:event.messageId,providerMessageId:event.messageId,
      occurredAt:previous?.occurred_at ?? event.occurredAt,text:event.body ?? "[Anexo]",messageType:"text",
      quotedExternalId:event.replyToMessageId ?? null,
      ingestionSource:"realtime_notify",
      triageState:config.monitored ? "unreviewed" : "context",
    });
    this.database.prepare(`INSERT INTO channel_message_versions (message_id,connection_id,external_message_id,revision_at,attachments_json)
      VALUES (?,?,?,?,?) ON CONFLICT(message_id) DO UPDATE SET revision_at=excluded.revision_at,attachments_json=excluded.attachments_json`)
      .run(messageId,connection.id,event.messageId,event.eventOccurredAt,JSON.stringify(event.attachments));
    if (previous) this.store.notifyConversationMessageChanged(conversationId);
  }

  private upsertAuthor(connectionId: string, event: ChannelMessageEvent): string {
    if (!event.authorId || !event.authorName || !event.authorRole) throw new ValidationError("Autor ausente.");
    const id = stableId(connectionId,"author",event.authorId); const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO participants (id,external_jid,connection_id,external_id,display_name,created_at,updated_at)
      VALUES (?,NULL,?,?,?,?,?) ON CONFLICT(connection_id,external_id) DO UPDATE SET display_name=excluded.display_name,updated_at=excluded.updated_at`)
      .run(id,connectionId,event.authorId,event.authorName,now,now);
    if (event.authorRole === "support") this.store.setStaffMember(id,event.authorName);
    return id;
  }
  private upsertConversation(connection: ConnectionRow, event: ChannelMessageEvent, id: string, config: ChannelConfig): void {
    let clientId = connection.client_id;
    const now = new Date().toISOString();
    if (!clientId) {
      clientId = stableId(connection.id,"unidentified");
      this.database.prepare(`INSERT INTO clients (id,name,slug,kind,identification_pending,created_at,updated_at)
        VALUES (?,?,?,'ecommerce',1,?,?) ON CONFLICT(id) DO NOTHING`).run(clientId,connection.name,`channel-${connection.id}`,now,now);
    }
    this.database.prepare(`INSERT INTO conversations
      (id,account_id,client_id,external_jid,connection_id,external_id,thread_id,external_url,conversation_scope,subject,monitored,triage_enabled_at,created_at,updated_at)
      VALUES (?,NULL,?,NULL,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET monitored=excluded.monitored,subject=COALESCE(?,conversations.subject),external_url=COALESCE(excluded.external_url,conversations.external_url),updated_at=excluded.updated_at`)
      .run(id,clientId,connection.id,event.conversationId,event.threadId ?? null,event.externalUrl ?? null,config.conversationScope,
        event.conversationTitle ?? event.conversationId,config.monitored?1:0,"1970-01-01T00:00:00.000Z",now,now,event.conversationTitle ?? null);
  }
  private audit(record: EventRow,event: ChannelMessageEvent,messageId: string,previous: string|null): void {
    this.database.prepare("INSERT INTO channel_message_audit (id,event_id,message_id,event_type,previous_text,occurred_at) VALUES (?,?,?,?,?,?)")
      .run(randomUUID(),record.id,messageId,event.eventType,previous,event.eventOccurredAt);
  }
  private validateClient(id: string|null|undefined): void {
    if (id && !this.database.prepare("SELECT id FROM clients WHERE id=? AND ignored_at IS NULL").get(id)) throw new ValidationError("Cliente inválido.");
  }
  private row(id: string): ConnectionRow {
    const row = this.database.prepare("SELECT * FROM channel_connections WHERE id=?").get(id) as ConnectionRow|undefined;
    if (!row) throw new NotFoundError("Canal",id);
    return row;
  }
  private dto(row: ConnectionRow): ChannelConnection {
    const count = (state: string) => (this.database.prepare("SELECT COUNT(*) AS count FROM channel_events WHERE connection_id=? AND state=?").get(row.id,state) as {count:number}).count;
    return {id:row.id,name:row.name,description:row.description,status:row.status,clientId:row.client_id,config:JSON.parse(row.config_json),
      lastReceivedAt:row.last_received_at,lastError:row.last_error,lastPreviewAt:row.last_preview_at,
      pendingCount:count("pending"),failedCount:count("failed"),webhookPath:`/api/channels/${row.id}/events`,createdAt:row.created_at,updatedAt:row.updated_at};
  }
}
