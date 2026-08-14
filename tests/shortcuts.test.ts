import assert from "node:assert/strict";
import test from "node:test";

import {
  handleSupportSearchShortcut,
  isSupportSearchShortcut,
} from "../app/lib/shortcuts.js";

test("Command K e Ctrl K abrem a busca global", () => {
  for (const shortcut of [
    { key: "k", metaKey: true, ctrlKey: false },
    { key: "K", metaKey: false, ctrlKey: true },
  ]) {
    let opened = 0;
    let prevented = 0;
    assert.equal(
      handleSupportSearchShortcut(
        { ...shortcut, preventDefault: () => prevented++ },
        () => opened++,
      ),
      true,
    );
    assert.equal(opened, 1);
    assert.equal(prevented, 1);
  }
});

test("atalho de busca ignora combinações e repetições não intencionais", () => {
  assert.equal(
    isSupportSearchShortcut({ key: "k", metaKey: false, ctrlKey: false }),
    false,
  );
  assert.equal(
    isSupportSearchShortcut({
      key: "k",
      metaKey: true,
      ctrlKey: false,
      shiftKey: true,
    }),
    false,
  );
  assert.equal(
    isSupportSearchShortcut({
      key: "k",
      metaKey: true,
      ctrlKey: false,
      repeat: true,
    }),
    false,
  );
  assert.equal(
    isSupportSearchShortcut({
      key: "k",
      metaKey: true,
      ctrlKey: false,
      isComposing: true,
    }),
    false,
  );
  assert.equal(
    isSupportSearchShortcut({
      key: "k",
      metaKey: true,
      ctrlKey: false,
      defaultPrevented: true,
    }),
    false,
  );
});
