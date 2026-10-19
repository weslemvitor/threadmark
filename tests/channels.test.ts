import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import test from "node:test";
import { createDatabase } from "../server/db/index.js";
import { SupportStore } from "../server/domain/support-store.js";
import { ChannelService } from "../server/channels/service.js";
import { channelConfigSchema } from "../server/channels/normalize.js";
import { createApiApp, createTestApiApp } from "../server/index.js";
import { LocalAuthService } from "../server/auth/index.js";
import { DirectoryStore } from "../server/domain/directory-store.js";

const sample = {
  eventId:"event-1", eventType:"message.created", eventOccurredAt:"2026-10-15T12:00:00Z",
  messageId:"message-1",conversationId:"conversation-1",conversationTitle:"Suporte geral",
  authorId:"contact-1",authorName:"Pessoa cliente",authorRole:"customer",
  body:"Preciso de ajuda com a integração.",occurredAt:"2026-10-15T12:00:00Z",
};
async function fixture(configInput: unknown = {}) {
  const database = createDatabase(":memory:"); const store = new SupportStore(database);
  const secrets = new Map<string,string>();
  const signatureSecret = randomBytes(32).toString("base64url");
  const channels = new ChannelService(store,{set:async (key,value) => {secrets.set(key,value);},get:async key=>secrets.get(key) ?? null});
  const result = await channels.create({name:"Canal livre",config:channelConfigSchema.parse(configInput),signatureSecret},"Operador");
  return {database,store,channels,signatureSecret,...result};
}
function activate(channels: ChannelService,id: string,payload: unknown = sample) {
  channels.preview(id,payload); channels.setStatus(id,"active");
}

test("canal nasce desativado e prévia não grava mensagens nem abre tickets", async () => {
  const f = await fixture();
  try {
    assert.equal(f.connection.status,"draft");
    assert.throws(()=>f.channels.setStatus(f.connection.id,"active"),/Teste uma mensagem/);
    const preview = f.channels.preview(f.connection.id,sample);
    assert.equal(preview.authorRole,"customer");
    assert.equal(f.store.listConversations().total,0);
    assert.equal(f.store.listTickets().total,0);
    assert.equal(f.channels.events(f.connection.id).length,0);
    assert.doesNotMatch(JSON.stringify(f.channels.list()),new RegExp(f.token!));
  } finally {f.database.close();}
});

test("recebimento durável reaproveita conversas, triagem e tickets sem duplicar eventos", async () => {
  const f = await fixture();
  try {
    activate(f.channels,f.connection.id);
    const first = f.channels.receive(f.connection.id,sample);
    assert.equal(f.channels.receive(f.connection.id,sample).duplicate,true);
    assert.equal(f.store.listConversations().total,0);
    assert.equal(f.channels.events(f.connection.id)[0]?.state,"pending");
    // A new worker instance can resume the durable queue after a restart.
    const resumed = new ChannelService(f.store,{set:async()=>{},get:async()=>null});
    assert.equal(resumed.processPending(),1);
    assert.equal(resumed.events(f.connection.id)[0]?.state,"processed");
    const conversation = f.store.listConversations().items[0]!;
    assert.equal(conversation.subject,sample.conversationTitle);
    assert.equal(conversation.channel?.name,"Canal livre");
    assert.equal(conversation.externalJid,"");
    assert.equal(conversation.pendingCount,1);
    const messages = f.store.getConversationMessages(conversation.id).items;
    assert.equal(messages[0]?.text,sample.body);
    assert.equal(messages[0]?.sender.isStaff,false);
    assert.equal(f.store.listTriageCandidates()[0]?.group.externalJid, "");
    const ticket = f.store.createTicketFromConversation(conversation.id,{
      clientRequestId:"new-channel-ticket",messageIds:[messages[0]!.id],actor:"Operador",
    }).ticket!;
    assert.equal(ticket.channel?.id,f.connection.id);
    assert.equal(f.store.listTickets({connectionId:f.connection.id}).total,1);
    assert.equal(first.eventId,resumed.events(f.connection.id)[0]?.id);
  } finally {f.database.close();}
});

test("identidades e mensagens iguais em conexões distintas não colidem", async () => {
  const f = await fixture();
  try {
    const other = await f.channels.create({name:"Segundo canal",config:channelConfigSchema.parse({})},"Operador");
    for (const id of [f.connection.id,other.connection.id]) {activate(f.channels,id);f.channels.receive(id,sample);}
    f.channels.processPending();
    assert.equal(f.store.listConversations().total,2);
    assert.equal((f.database.prepare("SELECT COUNT(*) AS count FROM participants").get() as {count:number}).count,2);
    assert.equal(f.store.listConversations({connectionId:other.connection.id}).total,1);
    assert.equal(f.database.prepare("SELECT id FROM whatsapp_accounts").get(),undefined);
    assert.equal(f.database.prepare("SELECT id FROM whatsapp_groups").get(),undefined);
  } finally {f.database.close();}
});

test("diretório e cliente contam participantes do canal sem depender de JIDs ou tickets", async () => {
  const f = await fixture();
  try {
    const client = f.store.upsertClient({id: "channel-client", name: "Cliente do canal", slug: "channel-client", kind: "ecommerce"});
    await f.channels.update(f.connection.id, {name: "Canal do cliente", clientId: client.id, config: channelConfigSchema.parse({})});
    activate(f.channels, f.connection.id);
    f.channels.receive(f.connection.id, sample);
    f.channels.receive(f.connection.id, {...sample, eventId: "event-2", messageId: "message-2", authorId: "contact-2"});
    f.channels.processPending();
    const listed = f.store.listClients().find(item => item.id === client.id)!;
    assert.equal(listed.participantCount, 2);
    assert.equal(listed.ticketCount, 0);
    assert.equal(listed.groups[0]?.externalJid, "");
    const directory = new DirectoryStore(f.database).getSnapshot();
    assert.equal(directory.groups[0]?.participantCount, 2);
    assert.equal(directory.people.length, 2);
    assert.ok(directory.people.every(person => person.activeGroupCount === 1 && person.phoneE164 === null));
  } finally {f.database.close();}
});

test("papel da equipe fica como contexto e não é desfeito pela configuração do WhatsApp", async () => {
  const f = await fixture();
  try {
    const message = {...sample,authorRole:"support"}; activate(f.channels,f.connection.id,message);
    f.channels.receive(f.connection.id,message);f.channels.processPending();
    f.store.reconcileStaffMembers([]);
    const conversation = f.store.listConversations().items[0]!;
    const captured = f.store.getConversationMessages(conversation.id).items[0]!;
    assert.equal(captured.sender.isStaff,true);
    assert.equal(captured.triage.state,"context");
    assert.equal(conversation.pendingCount,0);
  } finally {f.database.close();}
});

test("mapeamento aceita JSON diferente sem adicionar um fornecedor ao código", async () => {
  const config = {format:"mapped",timestampFormat:"unix_seconds",roleMapping:{visitor:"customer"},eventTypeMapping:{created:"message.created"},mapping:{
    eventId:"id",messageId:"data.id",conversationId:"data.room",authorId:"data.sender.id",authorName:"data.sender.name",
    authorRole:"data.sender.role",body:"data.text",occurredAt:"data.time",eventType:"kind",
  }};
  const payload = {id:123,kind:"created",data:{id:"m1",room:"r1",sender:{id:"u1",name:"Visitante",role:"visitor"},text:"Ajuda",time:1792065600}};
  const f=await fixture(config);
  try {activate(f.channels,f.connection.id,payload);f.channels.receive(f.connection.id,payload);f.channels.processPending();
    assert.equal(f.store.listConversations().total,1);
    assert.equal(f.channels.events(f.connection.id)[0]?.state,"processed");
    assert.throws(()=>channelConfigSchema.parse({...config,mapping:{...config.mapping,body:"data.__proto__.text"}}));
  } finally {f.database.close();}
});

test("edições antigas não sobrescrevem recentes e exclusão preserva a auditoria", async () => {
  const f = await fixture();
  try {
    activate(f.channels,f.connection.id);f.channels.receive(f.connection.id,sample);f.channels.processPending();
    f.channels.receive(f.connection.id,{...sample,eventId:"edit-2",eventType:"message.updated",eventOccurredAt:"2026-10-15T12:05:00Z",body:"Texto atualizado"});f.channels.processPending();
    f.channels.receive(f.connection.id,{...sample,eventId:"edit-1",eventType:"message.updated",eventOccurredAt:"2026-10-15T12:03:00Z",body:"Texto antigo"});f.channels.processPending();
    let message=f.store.getConversationMessages(f.store.listConversations().items[0]!.id).items[0]!;
    assert.equal(message.text,"Texto atualizado");
    f.channels.receive(f.connection.id,{...sample,eventId:"delete-1",eventType:"message.deleted",eventOccurredAt:"2026-10-15T12:06:00Z"});f.channels.processPending();
    message=f.store.getConversationMessages(f.store.listConversations().items[0]!.id).items[0]!;
    assert.equal(message.text,"[Mensagem excluída na origem]");
    assert.equal(message.triage.state,"context");
    const audit=f.database.prepare("SELECT previous_text FROM channel_message_audit ORDER BY occurred_at").all();
    assert.deepEqual(audit,[{previous_text:sample.body},{previous_text:"Texto atualizado"}]);
  } finally {f.database.close();}
});

test("pausa preserva histórico, bloqueia novos eventos e suspende a fila", async () => {
  const f=await fixture();
  try {activate(f.channels,f.connection.id);f.channels.receive(f.connection.id,sample);f.channels.setStatus(f.connection.id,"paused");
    assert.throws(()=>f.channels.receive(f.connection.id,sample),/não está ativo/);
    assert.equal(f.channels.processPending(),0);f.channels.setStatus(f.connection.id,"active");f.channels.processPending();
    f.channels.setStatus(f.connection.id,"paused");assert.equal(f.store.listConversations().total,1);
  } finally {f.database.close();}
});

test("falha de processamento pode ser reprocessada após a mensagem original chegar", async () => {
  const f=await fixture();
  try {activate(f.channels,f.connection.id);
    f.channels.receive(f.connection.id,{...sample,eventId:"update-before-create",eventType:"message.updated",eventOccurredAt:"2026-10-15T12:10:00Z",body:"Atualização"});f.channels.processPending();
    const failed=f.channels.events(f.connection.id)[0]!;assert.equal(failed.errorCode,"channel_message_missing");
    f.channels.receive(f.connection.id,sample);f.channels.processPending();f.channels.retry(f.connection.id,failed.id);f.channels.processPending();
    assert.equal(f.channels.events(f.connection.id).find(e=>e.id===failed.id)?.state,"processed");
    assert.equal(f.store.listConversations().total,1);
  } finally {f.database.close();}
});

test("API de coleta exige credencial própria, retorna 202 e limita o corpo", async () => {
  const f=await fixture();
  try {activate(f.channels,f.connection.id);const app=createTestApiApp(f.store,undefined,undefined,{channels:f.channels});
    const path=f.connection.webhookPath;const body=JSON.stringify(sample);
    const invalid=await app.request(path,{method:"POST",headers:{"content-type":"application/json"},body});assert.equal(invalid.status,401);
    const received=await app.request(path,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${f.token}`},body});assert.equal(received.status,202);
    assert.equal(f.channels.events(f.connection.id)[0]?.state,"pending");
    const huge=await app.request(path,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${f.token}`},body:"x".repeat(256*1024+1)});assert.equal(huge.status,413);
  } finally {f.database.close();}
});

test("credencial de coleta não autoriza leitura nem administração e operador não configura canais", async () => {
  const f = await fixture();
  try {
    const auth = new LocalAuthService(f.database);
    const owner = await auth.bootstrapSetup({
      organizationName: "Organização de teste", workspaceName: "Suporte", timezone: "America/Sao_Paulo",
      username: "owner", displayName: "Proprietário", password: "local test password for channels",
    });
    await auth.createUser(owner.token, {
      username: "operator", displayName: "Operador", role: "operator", password: "local operator password for channels",
    });
    const operator = await auth.login({username: "operator", password: "local operator password for channels"});
    const app = createApiApp(f.store, undefined, undefined, {auth, channels: f.channels});
    activate(f.channels, f.connection.id);
    const headers = {authorization: `Bearer ${f.token}`};
    assert.equal((await app.request("/api/conversations", {headers})).status, 401);
    assert.equal((await app.request("/api/channels", {headers})).status, 401);
    assert.equal((await app.request(`${f.connection.webhookPath}/anything`, {method: "POST", headers})).status, 401);
    assert.equal((await app.request(f.connection.webhookPath, {
      method: "POST", headers: {...headers, "content-type": "application/json"}, body: JSON.stringify(sample),
    })).status, 202);
    const operatorHeaders = {cookie: `threadmark_session=${operator.token}`, "content-type": "application/json"};
    assert.equal((await app.request("/api/channels", {headers: operatorHeaders})).status, 200);
    assert.equal((await app.request("/api/channels", {
      method: "POST", headers: operatorHeaders, body: JSON.stringify({name: "Não permitido", config: {}}),
    })).status, 403);
    assert.equal((await app.request(f.connection.webhookPath, {headers: operatorHeaders})).status, 403);
    const rotated = f.channels.rotateToken(f.connection.id);
    await assert.rejects(f.channels.authenticate(f.connection.id, new Headers(headers)), /inválida/);
    await f.channels.authenticate(f.connection.id, new Headers({authorization: `Bearer ${rotated}`}));
  } finally { f.database.close(); }
});

test("mudança de configuração exige novo teste e anexos externos permanecem referências", async () => {
  const f = await fixture();
  try {
    activate(f.channels, f.connection.id);
    const config = channelConfigSchema.parse({conversationScope: "direct"});
    await f.channels.update(f.connection.id, {name: "Canal atualizado", config});
    assert.equal(f.channels.get(f.connection.id).status, "draft");
    assert.throws(() => f.channels.setStatus(f.connection.id, "active"), /Teste uma mensagem/);
    const payload = {...sample, body: "", attachments: [{id: "file-1", name: "arquivo.pdf", mimeType: "application/pdf", url: "https://example.com/file.pdf"}]};
    activate(f.channels, f.connection.id, payload);
    f.channels.receive(f.connection.id, payload); f.channels.processPending();
    const conversation = f.store.listConversations().items[0]!;
    const message = f.store.getConversationMessages(conversation.id).items[0]!;
    assert.equal(conversation.scope, "direct");
    assert.deepEqual(message.externalAttachments, payload.attachments);
    assert.deepEqual(message.attachments, []);
    assert.throws(() => f.channels.preview(f.connection.id, {...payload, attachments: [{...payload.attachments[0], url: "http://example.com/private"}]}));
  } finally { f.database.close(); }
});

test("assinatura HMAC valida o corpo exato e rejeita alterações", async () => {
  const f=await fixture({authentication:"hmac_sha256"});
  try {activate(f.channels,f.connection.id);const raw=JSON.stringify(sample);const signature=createHmac("sha256",f.signatureSecret).update(raw).digest("hex");
    await f.channels.authenticate(f.connection.id,new Headers({"X-Channel-Signature":signature}),raw);
    await assert.rejects(f.channels.authenticate(f.connection.id,new Headers({"X-Channel-Signature":signature}),raw+" "),/inválida/);
  } finally {f.database.close();}
});
