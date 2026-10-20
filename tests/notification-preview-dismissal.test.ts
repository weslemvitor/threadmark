import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const previewSource = new URL(
  "../app/features/notifications/components/notification-preview.tsx",
  import.meta.url,
);
const headerSource = new URL("../app/components/layout/page-header.tsx", import.meta.url);
const appSource = new URL("../app/support-app.tsx", import.meta.url);

test("abrir o sino dispensa toda a fila de prévias sem marcar notificações como lidas", async () => {
  const [preview, header, app] = await Promise.all([
    readFile(previewSource, "utf8"),
    readFile(headerSource, "utf8"),
    readFile(appSource, "utf8"),
  ]);

  const handlerStart = preview.indexOf("const handleOpenChange");
  const handlerEnd = preview.indexOf("\n\n  const load", handlerStart);
  const openHandler = preview.slice(handlerStart, handlerEnd);

  assert.match(preview, /<Popover onOpenChange=\{handleOpenChange\}/);
  assert.match(openHandler, /if \(nextOpen\) onOpenPreview\(\)/);
  assert.doesNotMatch(openHandler, /updateNotificationRead|markAllNotificationsRead/);
  assert.match(header, /onOpenPreview=\{onOpenNotificationPreview\}/);
  assert.match(app, /onOpenNotificationPreview=\{dismissNotificationPreviews\}/);
  assert.match(
    app,
    /const dismissNotificationPreviews = useCallback\(\(\) => \{\s*setNotificationPreviewQueue\(\[\]\);/,
  );
});
