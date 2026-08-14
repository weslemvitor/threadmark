export interface ShortcutKeyboardEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
}

export function isSupportSearchShortcut(
  event: ShortcutKeyboardEvent,
): boolean {
  return (
    !event.altKey &&
    !event.shiftKey &&
    !event.repeat &&
    !event.isComposing &&
    !event.defaultPrevented &&
    (event.metaKey || event.ctrlKey) &&
    event.key.toLocaleLowerCase() === "k"
  );
}

export function handleSupportSearchShortcut(
  event: ShortcutKeyboardEvent & { preventDefault: () => void },
  openSearch: () => void,
): boolean {
  if (!isSupportSearchShortcut(event)) return false;
  event.preventDefault();
  openSearch();
  return true;
}
