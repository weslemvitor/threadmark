import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("keeps WhatsApp conversations inbound-only in the UI", async () => {
  const [detail, room, api, page, layout, css] = await Promise.all([
    readFile(new URL("../app/features/tickets/components/ticket-detail.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/tickets/components/investigation-room.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/api.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(detail, /modo somente leitura/);
  assert.doesNotMatch(detail, /Investigação assistida|ticket-ai-guidance|Investigar novamente/);
  assert.match(detail, /Sala de investigação/);
  assert.match(detail, /só é iniciada quando você abrir/);
  assert.match(detail, /Abrir sala de investigação/);
  assert.match(detail, /Marcar como resolvido/);
  assert.match(detail, /Adicionar nota interna/);
  assert.match(detail, /nunca é enviada ao WhatsApp/);
  assert.match(detail, /aria-label="Editar nota interna"/);
  assert.match(detail, /aria-label="Excluir nota interna"/);
  assert.match(detail, /Excluir esta nota\?/);
  assert.match(detail, /Editada por/);
  assert.match(detail, /Mostrar eventos/);
  assert.match(detail, /Ocultar eventos/);
  assert.match(detail, /Registrar bug para Produto/);
  assert.match(detail, /Editar bug encaminhado/);
  assert.match(detail, /className="ticket-product-forwarding-card"/);
  assert.doesNotMatch(
    detail,
    /sendMessage|\/messages\/outbound|Enviar ao WhatsApp|Responder no WhatsApp/i,
  );
  assert.match(room, /Conversa do WhatsApp/);
  assert.match(room, /Somente leitura/);
  assert.match(room, /nunca envia[\s\S]*mensagens ao WhatsApp/);
  assert.match(room, /Converse com a IA sobre este ticket/);
  assert.doesNotMatch(room, /sendMessage|\/messages\/outbound|Enviar ao WhatsApp/i);
  assert.doesNotMatch(api, /sendMessage|\/send|\/messages\/outbound/i);
  assert.match(api, /http:\/\/127\.0\.0\.1:4317/);
  assert.doesNotMatch(api, /\/api\/tickets\/\$\{encodeURIComponent\(id\)\}\/investigate/);
  assert.match(api, /\/api\/tickets\/\$\{encodeURIComponent\(id\)\}\/notes/);
  assert.match(api, /\/api\/investigation-threads\/\$\{encodeURIComponent\(threadId\)\}\/messages/);
  assert.match(page, /<SupportApp \/>/);
  assert.match(layout, /lang="pt-BR"/);
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(css, /@media \(max-width: 840px\)/);
  assert.match(css, /prefers-reduced-motion: reduce/);

  await assert.rejects(
    access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)),
  );
});

test("keeps client editing persistent and the side panels responsive", async () => {
  const [clients, editor, api, css] = await Promise.all([
    readFile(new URL("../app/features/directory/components/clients-view.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/directory/components/client-editor.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/api.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(clients, /Editar \$\{client\.name\}/);
  assert.match(editor, /Editar cliente e ecommerces/);
  assert.match(editor, /Adicionar ecommerce/);
  assert.match(editor, /Salvar alterações/);
  assert.match(api, /method: "PUT"/);
  assert.match(api, /\/api\/clients\/\$\{encodeURIComponent\(id\)\}/);
  assert.match(css, /\.ticket-side-panel \{[\s\S]*?overflow-x: hidden/);
  assert.match(
    css,
    /@media \(max-width: 1279px\) \{[\s\S]*?\.sidebar \{[\s\S]*?position: fixed/,
  );
  assert.match(css, /grid-template-columns: minmax\(0, 42%\) minmax\(0, 1fr\)/);
});
