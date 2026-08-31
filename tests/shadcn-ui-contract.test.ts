import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test from "node:test";
import * as ts from "typescript";
import { readFrontendFile as readFile } from "./helpers/frontend-source.js";

const pageSources = [
  "../app/features/access/components/app-access-gate.tsx",
  "../app/features/categories/components/categories-view.tsx",
  "../app/features/conversations/components/conversations-view.tsx",
  "../app/features/dashboard/components/dashboard-view.tsx",
  "../app/features/directory/components/directory-view.tsx",
  "../app/features/kanban/components/kanban-view.tsx",
  "../app/features/settings/components/settings-view.tsx",
  "../app/features/tickets/components/ticket-detail.tsx",
] as const;

test("Shadcn está configurado sobre o tema visual do Threadmark", async () => {
  const [configurationSource, css, layout] = await Promise.all([
    readFile(new URL("../components.json", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
  ]);
  const configuration = JSON.parse(configurationSource) as {
    style?: string;
    tailwind?: { css?: string; cssVariables?: boolean };
    aliases?: { ui?: string; utils?: string };
  };

  assert.equal(configuration.style, "radix-nova");
  assert.equal(configuration.tailwind?.css, "app/globals.css");
  assert.equal(configuration.tailwind?.cssVariables, true);
  assert.equal(configuration.aliases?.ui, "@/app/components/ui");
  assert.equal(configuration.aliases?.utils, "@/app/lib/utils");
  assert.match(css, /--primary:\s*var\(--brand\)/);
  assert.match(css, /--accent:\s*var\(--brand-soft\)/);
  assert.match(css, /--chart-1:/);
  assert.match(css, /@custom-variant dark/);
  assert.match(layout, /<TooltipProvider>/);
});

test("todas as superfícies principais consomem primitives Shadcn compartilhados", async () => {
  const sources = await Promise.all(
    pageSources.map(async (sourcePath) => ({
      sourcePath,
      source: await readFile(new URL(sourcePath, import.meta.url), "utf8"),
    })),
  );

  for (const { sourcePath, source } of sources) {
    assert.match(
      source,
      /from ["'](?:\.{1,3}\/)+(?:components\/)?ui\/|from ["']@\/app\/components\/ui\//,
      `${sourcePath} deve usar ao menos um primitive compartilhado de app/components/ui`,
    );
  }
});

async function tsxFiles(directory: URL): Promise<URL[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const target = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
      if (entry.isDirectory()) {
        if (target.pathname.endsWith("/app/components/ui/")) return [];
        return tsxFiles(target);
      }
      return entry.isFile() && entry.name.endsWith(".tsx") ? [target] : [];
    }),
  );
  return files.flat();
}

test("controles interativos passam exclusivamente pelos primitives Shadcn", async () => {
  const roots = [
    new URL("../app/components/", import.meta.url),
    new URL("../app/features/", import.meta.url),
  ];
  const files = (await Promise.all(roots.map(tsxFiles))).flat();
  const violations: string[] = [];

  for (const file of files) {
    const source = await readFile(file, "utf8");
    const nativeControls = source.match(/<(?:button|input|select|textarea)(?:\s|>)/g);
    if (nativeControls?.length) {
      violations.push(`${file.pathname}: ${nativeControls.join(", ")}`);
    }
  }

  assert.deepEqual(
    violations,
    [],
    "Use Button, Input, Select ou Textarea de app/components/ui",
  );
});

test("features não reintroduzem o seletor nativo legado", async () => {
  const files = await tsxFiles(new URL("../app/features/", import.meta.url));
  const violations: string[] = [];

  for (const file of files) {
    const source = await readFile(file, "utf8");
    if (/NativeSelect|components\/ui\/native-select/.test(source)) {
      violations.push(file.pathname);
    }
  }

  assert.deepEqual(violations, [], "Use Select ou Combobox do Shadcn");
});

test("cadastro do Intercom usa formulário Shadcn sem valores de exemplo persistidos", async () => {
  const source = await readFile(
    new URL("../app/features/automations/components/connected-apps-panel.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /<SelectItem value="intercom">Intercom<\/SelectItem>/);
  assert.match(source, /Access token da API do Intercom/);
  assert.match(source, /Região do workspace/);
  assert.match(source, /Leitura de conversas, do autor associado ao token e de coleções/);
  assert.match(source, /type === "intercom" \? INTERCOM_REGIONS\[0\]\.value : ""/);
  assert.doesNotMatch(source, /name: type === "slack_webhook"/);
  assert.doesNotMatch(source, /Slack do suporte/);
  assert.doesNotMatch(source, /Minha API/);
});

test("combobox compartilhado usa Popover Shadcn e semântica acessível de lista", async () => {
  const [combobox, popover] = await Promise.all([
    readFile(new URL("../app/components/ui/combobox.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ui/popover.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(combobox, /from "@\/app\/components\/ui\/popover"/);
  assert.match(combobox, /role="combobox"/);
  assert.match(combobox, /role="listbox"/);
  assert.match(combobox, /role="option"/);
  assert.match(combobox, /aria-activedescendant/);
  assert.match(combobox, /max-h-72 overflow-y-auto/);
  assert.match(combobox, /modal/);
  assert.match(combobox, /listbox\.scrollTop \+= event\.deltaY/);
  assert.match(popover, /PopoverPrimitive\.Portal/);
  assert.match(popover, /z-110/);
});

test("botões sem estilo também removem a dimensão padrão do primitive", async () => {
  const roots = [
    new URL("../app/components/", import.meta.url),
    new URL("../app/features/", import.meta.url),
  ];
  const files = (await Promise.all(roots.map(tsxFiles))).flat();
  const violations: string[] = [];

  for (const file of files) {
    const source = await readFile(file, "utf8");
    const sourceFile = ts.createSourceFile(
      file.pathname,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );

    function visit(node: ts.Node): void {
      if (
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        node.tagName.getText(sourceFile) === "Button"
      ) {
        const attributes = new Map(
          node.attributes.properties
            .filter(ts.isJsxAttribute)
            .map((attribute) => [
              attribute.name.getText(sourceFile),
              attribute.initializer && ts.isStringLiteral(attribute.initializer)
                ? attribute.initializer.text
                : null,
            ]),
        );
        if (
          attributes.get("variant") === "unstyled" &&
          attributes.get("size") !== "unstyled"
        ) {
          const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          violations.push(`${file.pathname}:${position.line + 1}`);
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  assert.deepEqual(
    violations,
    [],
    'Button variant="unstyled" deve usar size="unstyled" para não herdar h-8',
  );
});

test("dashboard usa donut para status e barras para categorias com Shadcn Charts", async () => {
  const [viewSource, chartsSource] = await Promise.all([
    readFile(
      new URL("../app/features/dashboard/components/dashboard-view.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/features/dashboard/components/dashboard-charts.tsx", import.meta.url),
      "utf8",
    ),
  ]);
  const source = `${viewSource}\n${chartsSource}`;

  assert.match(source, /from "recharts"/);
  assert.match(source, /ChartContainer/);
  assert.match(source, /ChartTooltipContent/);
  assert.match(source, /<PieChart/);
  assert.match(source, /<Pie/);
  assert.match(source, /innerRadius=\{48\}/);
  assert.match(source, /DashboardStatusDonut/);
  assert.match(source, /Distribuição por status/);
  assert.match(viewSource, /grid-flow-row-dense/);
  assert.match(viewSource, /lg:grid-cols-12/);
  assert.match(source, /<AreaChart/);
  assert.match(source, /<Area/);
  assert.match(source, /<BarChart/);
  assert.match(source, /<CartesianGrid/);
  assert.match(source, /<XAxis/);
  assert.match(source, /<YAxis/);
  assert.match(source, /h-48 w-full aspect-auto/);
  assert.match(source, /item\.payload\.label/);
  assert.match(source, /Quantidade de tickets/);
  assert.match(source, /DashboardHorizontalBars items=\{categoryItems\}/);
  assert.doesNotMatch(source, /DashboardHorizontalBars items=\{statusItems\}/);
  assert.doesNotMatch(source, /dashboard-(?:daily|horizontal)-chart/);
  assert.match(viewSource, /<div className="grid gap-1\.5">/);
  assert.match(viewSource, /rounded-lg border border-border bg-background px-2/);
});

test("contexto do ticket ocupa a página sem recriar uma listagem lateral", async () => {
  const [shell, header, detail, context, categories] = await Promise.all([
    readFile(
      new URL("../app/support-app.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/components/layout/page-header.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/features/tickets/components/ticket-detail.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/features/tickets/components/ticket-context-panel.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/features/tickets/components/ticket-category-panel.tsx", import.meta.url),
      "utf8",
    ),
  ]);

  assert.doesNotMatch(shell, /<TicketList/);
  assert.doesNotMatch(shell, /grid-cols-\[346px_minmax\(0,1fr\)\]/);
  assert.match(header, /<h1 className="[^"]*text-xl[^"]*font-semibold/);
  assert.match(detail, /truncate text-lg font-semibold/);
  assert.match(detail, /truncate text-xs text-muted-foreground/);
  assert.match(detail, /aria-label="Voltar ao Kanban"/);
  assert.match(context, /<h3 className="text-sm font-semibold/);
  assert.match(categories, /<h3 className="text-sm font-semibold/);
  assert.match(categories, /from "@\/app\/components\/ui\/select"/);
  assert.match(categories, /from "@\/app\/components\/ui\/combobox"/);
  assert.match(categories, /<Combobox/);
  assert.match(categories, /<SelectTrigger[^>]*className="w-full text-xs"/);
  assert.match(categories, /categoryDisplayOrder/);
  assert.match(categories, /grid-cols-\[68px_minmax\(0,1fr\)\]/);
});

test("catálogo de categorias usa diálogo e busca Shadcn na exclusão segura", async () => {
  const source = await readFile(
    new URL("../app/features/categories/components/categories-view.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /from "@\/app\/components\/ui\/dialog"/);
  assert.match(source, /from "@\/app\/components\/ui\/combobox"/);
  assert.match(source, /Migrar e excluir/);
  assert.match(source, /Excluir definitivamente/);
});

test("Threadmark AI abre compacto, expande sem bloquear a tela e preserva gráficos responsivos", async () => {
  const [assistant, charts] = await Promise.all([
    readFile(new URL("../app/features/threadmark-ai/threadmark-ai.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/dashboard/components/dashboard-charts.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(assistant, /sm:w-\[400px\]/);
  assert.match(assistant, /sm:w-\[min\(920px,calc\(100vw-2\.5rem\)\)\]/);
  assert.match(assistant, /aria-label=\{expanded \? "Recolher Threadmark AI" : "Expandir Threadmark AI"\}/);
  assert.match(assistant, /aria-modal="false"/);
  assert.doesNotMatch(assistant, /SheetContent|from "@\/app\/components\/ui\/sheet"/);
  assert.match(assistant, /min-h-0 flex-1/);
  assert.match(charts, /const \[activeIndex, setActiveIndex\] = useState/);
  assert.match(charts, /activeItem\?\.value \?\? total/);
});

test("primitives não impõem layout legado nem deixam menus atrás de drawers", async () => {
  const [button, select, dropdownMenu, nodeConfigSheet, css] = await Promise.all([
    readFile(new URL("../app/components/ui/button.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ui/select.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ui/dropdown-menu.tsx", import.meta.url), "utf8"),
    readFile(
      new URL("../app/features/automations/components/node-config-sheet.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(button, /usesLegacyLayout/);
  assert.match(button, /variant = "default"/);
  assert.match(button, /size = "default"/);
  assert.match(button, /unstyled: ""/);
  assert.match(select, /Select as SelectPrimitive/);
  assert.match(select, /data-slot="select-trigger"/);
  assert.match(select, /data-slot="select-content"/);
  assert.match(select, /relative z-100/);
  assert.match(select, /text-xs outline-none select-none/);
  assert.match(dropdownMenu, /data-slot="dropdown-menu-content"[\s\S]*?z-100/);
  assert.match(dropdownMenu, /data-slot="dropdown-menu-sub-content"[\s\S]*?z-100/);
  assert.match(nodeConfigSheet, /<SheetContent className="bg-muted">/);
  assert.doesNotMatch(nodeConfigSheet, /<SheetContent className="bg-muted\/20">/);
  assert.doesNotMatch(css, /\.support-app-shell select[\s\S]*?background-image:/);
});

test("botões Shadcn usam uma escala tipográfica legível e consistente", async () => {
  const button = await readFile(
    new URL("../app/components/ui/button.tsx", import.meta.url),
    "utf8",
  );

  assert.match(button, /font-medium whitespace-nowrap/);
  assert.match(button, /default:\s*"h-8[^"]*text-sm/);
  assert.match(button, /xs:\s*"h-6[^"]*text-xs/);
  assert.match(button, /sm:\s*"h-7[^"]*text-xs/);
  assert.match(button, /lg:\s*"h-9[^"]*text-sm/);
  assert.doesNotMatch(button, /usesLegacyLayout/);
});

test("fluxos modais delegam foco e acessibilidade ao Dialog Shadcn", async () => {
  const modalSources = await Promise.all([
    readFile(
      new URL("../app/features/conversations/components/conversation-action-dialog.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/features/tickets/components/manual-ticket-dialog.tsx", import.meta.url),
      "utf8",
    ),
  ]);

  for (const source of modalSources) {
    assert.match(source, /from "@\/app\/components\/ui\/dialog"/);
    assert.match(source, /<Dialog/);
    assert.match(source, /<DialogContent/);
    assert.doesNotMatch(source, /className="fixed inset-0/);
    assert.doesNotMatch(source, /aria-modal="true"/);
    assert.doesNotMatch(source, /role="dialog"/);
  }
});
