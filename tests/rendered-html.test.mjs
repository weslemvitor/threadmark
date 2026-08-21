import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("keeps WhatsApp conversations inbound-only in the UI", async () => {
  const [detail, conversation, notes, product, assistant, api, page, threadmarkPage, layout] = await Promise.all([
    readFile(new URL("../app/features/tickets/components/ticket-detail.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/tickets/components/ticket-conversation.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/tickets/components/ticket-notes.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/tickets/components/ticket-product-panel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/threadmark-ai/threadmark-ai.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/api.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/threadmark-page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(detail, /modo somente leitura/);
  assert.doesNotMatch(detail, /Investigação assistida|ticket-ai-guidance|Investigar novamente/);
  assert.doesNotMatch(detail, /Sala de investigação|Abrir sala de investigação/);
  assert.match(detail, /Marcar como resolvido/);
  assert.match(notes, /Adicionar nota interna/);
  assert.match(notes, /nunca é enviada ao WhatsApp/);
  assert.match(notes, /aria-label="Editar nota interna"/);
  assert.match(notes, /aria-label="Excluir nota interna"/);
  assert.match(notes, /Excluir esta nota\?/);
  assert.match(notes, /Editada por/);
  assert.match(conversation, /Mostrar eventos/);
  assert.match(conversation, /Ocultar eventos/);
  assert.match(detail, /Registrar bug para Produto/);
  assert.match(product, /Editar bug/);
  assert.doesNotMatch(
    detail,
    /sendMessage|\/messages\/outbound|Enviar ao WhatsApp|Responder no WhatsApp/i,
  );
  assert.match(assistant, /Threadmark AI/);
  assert.match(assistant, /Nada é enviado ao WhatsApp/);
  assert.match(assistant, /Ações exigem confirmação/);
  assert.doesNotMatch(assistant, /sendMessage|\/messages\/outbound|Enviar ao WhatsApp/i);
  assert.doesNotMatch(api, /sendMessage|\/send|\/messages\/outbound/i);
  assert.match(api, /http:\/\/127\.0\.0\.1:4317/);
  assert.doesNotMatch(api, /\/api\/tickets\/\$\{encodeURIComponent\(id\)\}\/investigate/);
  assert.match(api, /\/api\/tickets\/\$\{encodeURIComponent\(id\)\}\/notes/);
  assert.match(api, /\/api\/threadmark-ai\/threads\/\$\{encodeURIComponent\(threadId\)\}\/messages/);
  assert.match(page, /<ThreadmarkPage initialPath="\/conversations" \/>/);
  assert.match(threadmarkPage, /<SupportApp initialPath=\{initialPath\} \/>/);
  assert.match(layout, /lang="pt-BR"/);

  await assert.rejects(
    access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)),
  );
});

test("keeps the agnostic directory persistent and the side panels responsive", async () => {
  const [directory, panels, api] = await Promise.all([
    readFile(new URL("../app/features/directory/components/directory-view.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/directory/components/directory-panels.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/api.ts", import.meta.url), "utf8"),
  ]);

  assert.match(directory, /Diretório/);
  assert.match(directory, /Grupos/);
  assert.match(directory, /Pessoas/);
  assert.match(panels, /Conversas coletivas sincronizadas do WhatsApp/);
  assert.match(panels, /Participantes observados nos grupos/);
  assert.match(api, /\/api\/directory/);
  assert.match(directory, /overflow-hidden rounded-2xl/);
  assert.match(directory, /flex-col gap-4[\s\S]*lg:flex-row/);
  assert.match(panels, /lg:grid-cols-2|2xl:grid-cols-3/);
});
