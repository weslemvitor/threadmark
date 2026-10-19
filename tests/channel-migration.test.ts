import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { migrations, migrateDatabase } from "../server/db/index.js";
import { SupportStore } from "../server/domain/support-store.js";

test("upgrade preserva WhatsApp e importa histórico externo sem duplicar a timeline", () => {
  const database=new Database(":memory:"); database.pragma("foreign_keys = ON");
  database.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL) STRICT");
  for(const migration of migrations.filter(item=>item.version<74)) {
    if(migration.disableForeignKeys)database.pragma("foreign_keys = OFF");
    database.transaction(()=>{database.exec(migration.sql);database.prepare("INSERT INTO schema_migrations VALUES (?,?,?)").run(migration.version,migration.name,"2026-10-15T12:00:00Z");})();
    database.pragma("legacy_alter_table = OFF");database.pragma("foreign_keys = ON");
  }
  try {
    const oldStore=new SupportStore(database);
    const account=oldStore.upsertAccount({id:"wa-account",phoneNumber:"commercial-account",displayName:"Conta comercial"});
    const client=oldStore.upsertClient({id:"existing-client",name:"Cliente existente",slug:"existing-client",kind:"ecommerce"});
    const group=oldStore.upsertGroup({id:"wa-group",accountId:account.id,clientId:client.id,externalJid:"migration@g.us",subject:"Grupo existente"});
    const author=oldStore.upsertParticipant({id:"wa-author",externalJid:"contact@lid",displayName:"Contato existente"});
    const original=oldStore.upsertMessage({id:"wa-message",groupId:group.id,senderId:author.id,externalId:"original-1",text:"Mensagem existente",messageType:"text",occurredAt:"2026-10-15T10:00:00Z"});
    const ticket=oldStore.createTicket({id:"old-ticket",groupId:group.id,sourceMessageId:original.id,title:"Atendimento existente",summary:"Histórico preservado"});
    oldStore.importExternalSourceMessagesToTicket(ticket.id,{sourceType:"intercom_conversation",sourceConversationId:"old-conversation",actor:"Operador",messages:[
      {id:"external-1",author:"Cliente externo",authorRole:"customer",body:"Mensagem importada",occurredAt:"2026-10-15T10:01:00Z"},
      {id:"external-2",author:"Equipe externa",authorRole:"support",body:"Resposta importada",occurredAt:"2026-10-15T10:02:00Z"},
    ]});
    const before=oldStore.getTicketDetail(ticket.id);
    const originalIds=before.timeline.filter(item=>item.type==="message").map(item=>item.id);
    const beforeRows=database.prepare("SELECT id,external_jid,account_id,triage_watermark_at FROM whatsapp_groups").all();
    migrateDatabase(database);migrateDatabase(database);
    const after=new SupportStore(database).getTicketDetail(ticket.id);
    assert.equal(after.messageCount,before.messageCount);
    assert.deepEqual(after.timeline.filter(item=>item.type==="message").map(item=>item.id),originalIds);
    assert.deepEqual(after.timeline.filter(item=>item.type==="message").map(item=>item.text),["Mensagem existente","Mensagem importada","Resposta importada"]);
    assert.deepEqual(database.prepare("SELECT id,external_jid,account_id,triage_watermark_at FROM whatsapp_groups").all(),beforeRows);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM channel_connections WHERE status='paused'").get() as {count:number}).count,1);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM ticket_external_messages WHERE migrated_message_id IS NOT NULL").get() as {count:number}).count,2);
    assert.deepEqual(database.pragma("foreign_key_check"),[]);
  } finally {database.close();}
});
