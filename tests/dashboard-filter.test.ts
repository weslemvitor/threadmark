import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  dashboardDateRangeError,
  dashboardExportFallbackName,
  formatDashboardRangeLabel,
  getDashboardPresetRange,
} from "../app/lib/dashboard-period.js";

const referenceDay = new Date("2026-07-18T15:00:00.000Z");

test("presets do dashboard usam datas locais inclusivas", () => {
  assert.deepEqual(getDashboardPresetRange("last_7_days", referenceDay), {
    from: "2026-07-12",
    to: "2026-07-18",
  });
  assert.deepEqual(getDashboardPresetRange("last_30_days", referenceDay), {
    from: "2026-06-19",
    to: "2026-07-18",
  });
  assert.deepEqual(getDashboardPresetRange("last_90_days", referenceDay), {
    from: "2026-04-20",
    to: "2026-07-18",
  });
  assert.deepEqual(getDashboardPresetRange("all_time", referenceDay), {});
  assert.deepEqual(
    getDashboardPresetRange(
      "last_7_days",
      new Date("2026-07-18T01:30:00.000Z"),
    ),
    { from: "2026-07-11", to: "2026-07-17" },
  );
  assert.deepEqual(
    getDashboardPresetRange(
      "last_7_days",
      new Date("2026-07-18T01:30:00.000Z"),
      "UTC",
    ),
    { from: "2026-07-12", to: "2026-07-18" },
  );
});

test("período personalizado valida ordem e gera rótulo e nome de exportação", () => {
  assert.equal(dashboardDateRangeError("", "2026-07-18"), "Informe as datas inicial e final.");
  assert.equal(
    dashboardDateRangeError("2026-07-19", "2026-07-18"),
    "A data inicial não pode ser posterior à data final.",
  );
  assert.equal(dashboardDateRangeError("2026-07-01", "2026-07-18"), null);
  assert.equal(
    formatDashboardRangeLabel({ from: "2026-07-01", to: "2026-07-18" }),
    "01/07/2026 a 18/07/2026",
  );
  assert.equal(formatDashboardRangeLabel({}), "Todo o histórico");
  assert.equal(
    dashboardExportFallbackName({ from: "2026-07-01", to: "2026-07-18" }),
    "threadmark-dashboard-2026-07-01-a-2026-07-18.csv",
  );
});

test("UI consulta e exporta exatamente o período e responsável selecionados", async () => {
  const [api, period, view, css] = await Promise.all([
    readFile(new URL("../app/lib/api.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/dashboard-period.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/features/dashboard/components/dashboard-view.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(api, /params\.set\("from", range\.from\)/);
  assert.match(api, /params\.set\("to", range\.to\)/);
  assert.match(api, /params\.set\("assigneeId", assigneeId\)/);
  assert.match(api, /\/api\/dashboard\/export/);
  assert.match(api, /await response\.blob\(\)/);
  assert.match(period, /last_7_days/);
  assert.match(period, /last_30_days/);
  assert.match(period, /last_90_days/);
  assert.match(period, /all_time/);
  assert.match(view, /type="date"/);
  assert.match(view, /Exportar CSV/);
  assert.match(view, /getDashboardExport\(range, selectedAssignee\)/);
  assert.match(view, /Filtrar dashboard por responsável/);
  assert.match(view, /Atendimento por responsável/);
  assert.match(view, /Eficiência operacional/);
  assert.match(view, /Envelhecimento do backlog/);
  assert.match(view, /Tickets por prioridade/);
  assert.match(view, /vs\. anterior/);
  assert.match(view, /Sem responsável/);
  assert.match(view, /currentDashboard\.period/);
  assert.match(view, /Tickets criados e resoluções de/);
  assert.match(view, /Snapshot atual da fila de auditoria/);
  assert.match(view, /Todo o período · gráfico dos últimos 14 dias/);
  assert.match(view, /aria-live="polite"/);
  assert.match(view, /lg:grid-cols-\[minmax\(210px,1fr\)_auto\]/);
  assert.match(view, /flex min-w-0 flex-wrap items-end gap-2/);
  assert.match(view, /wrapperClassName="w-full sm:w-fit"/);
  assert.doesNotMatch(css, /\.dashboard-(?:period|custom|export)-/);
});
