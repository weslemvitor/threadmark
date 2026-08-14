export type ViewId =
  | "conversations"
  | "inbox"
  | "kanban"
  | "clients"
  | "categories"
  | "dashboard"
  | "settings";

export const SETTINGS_ROUTE_TABS = [
  "general",
  "users",
  "staff",
  "whatsapp",
  "ai",
  "connectors",
  "tools",
  "data",
  "security",
] as const;

export type SettingsRouteTab = (typeof SETTINGS_ROUTE_TABS)[number];

export type ThreadmarkNavigation = {
  view: ViewId;
  ticketReference: string | null;
  settingsTab: SettingsRouteTab;
  legacy: boolean;
};

const VIEW_PATHS: Record<ViewId, string> = {
  conversations: "/conversations",
  inbox: "/tickets",
  kanban: "/kanban",
  clients: "/directory",
  categories: "/categories",
  dashboard: "/dashboard",
  settings: "/settings",
};

const PATH_VIEWS = new Map(
  Object.entries(VIEW_PATHS).map(([view, path]) => [path, view as ViewId]),
);

const LEGACY_VIEW_IDS = new Set<ViewId>(Object.keys(VIEW_PATHS) as ViewId[]);
const SETTINGS_TAB_SET = new Set<string>(SETTINGS_ROUTE_TABS);

function normalizePathname(pathname: string): string {
  const normalized = pathname.trim().replace(/\/{2,}/g, "/").replace(/\/$/, "");
  return normalized || "/";
}

function settingsTab(value: string | null | undefined): SettingsRouteTab {
  if (value === "team") return "staff";
  return value && SETTINGS_TAB_SET.has(value)
    ? (value as SettingsRouteTab)
    : "general";
}

export function buildThreadmarkPath({
  view,
  ticketReference,
  settingsTab: requestedSettingsTab,
}: {
  view: ViewId;
  ticketReference?: string | number | null;
  settingsTab?: SettingsRouteTab;
}): string {
  if (view === "inbox" && ticketReference !== null && ticketReference !== undefined) {
    return `/tickets/${encodeURIComponent(String(ticketReference).replace(/^#/, ""))}`;
  }
  if (view === "inbox") return "/kanban";
  if (view === "settings" && requestedSettingsTab && requestedSettingsTab !== "general") {
    return `/settings/${requestedSettingsTab}`;
  }
  return VIEW_PATHS[view];
}

export function parseThreadmarkLocation(
  pathname: string,
  search = "",
): ThreadmarkNavigation {
  const normalizedPath = normalizePathname(pathname);
  const segments = normalizedPath.split("/").filter(Boolean);

  if (segments[0] === "tickets" && segments[1]) {
    return {
      view: "inbox",
      ticketReference: decodeURIComponent(segments[1]),
      settingsTab: "general",
      legacy: false,
    };
  }

  if (normalizedPath === "/tickets") {
    return {
      view: "kanban",
      ticketReference: null,
      settingsTab: "general",
      legacy: true,
    };
  }

  if (segments[0] === "settings") {
    return {
      view: "settings",
      ticketReference: null,
      settingsTab: settingsTab(segments[1]),
      legacy: false,
    };
  }

  const directView = PATH_VIEWS.get(normalizedPath);
  if (directView) {
    return {
      view: directView,
      ticketReference: null,
      settingsTab: "general",
      legacy: false,
    };
  }

  const query = new URLSearchParams(search);
  const legacySettings = query.get("settings");
  const legacyView = query.get("view");
  if (legacySettings) {
    return {
      view: "settings",
      ticketReference: null,
      settingsTab: settingsTab(legacySettings),
      legacy: true,
    };
  }
  if (legacyView && LEGACY_VIEW_IDS.has(legacyView as ViewId)) {
    return {
      view: legacyView as ViewId,
      ticketReference: null,
      settingsTab: "general",
      legacy: true,
    };
  }

  return {
    view: "conversations",
    ticketReference: null,
    settingsTab: "general",
    legacy: normalizedPath === "/",
  };
}
