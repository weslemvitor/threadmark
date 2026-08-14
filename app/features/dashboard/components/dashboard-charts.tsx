import { useState, type ReactNode } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from "recharts";

import { Card } from "@/app/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/app/components/ui/chart";
import type { DashboardData } from "@/app/lib/types";
import { cn } from "@/app/lib/utils";

const chartColors = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--muted-foreground)",
];

const dailyChartConfig = {
  created: { label: "Criados", color: "var(--chart-1)" },
  resolved: { label: "Resolvidos", color: "var(--chart-4)" },
} satisfies ChartConfig;

const horizontalChartConfig = {
  value: { label: "Tickets", color: "var(--chart-1)" },
} satisfies ChartConfig;

type DashboardChartItem = {
  label: string;
  value: number;
  color?: string;
};

const metricToneClasses: Record<string, string> = {
  violet: "bg-primary/10 text-primary",
  blue: "bg-blue-500/10 text-blue-700",
  green: "bg-emerald-500/10 text-emerald-700",
  amber: "bg-amber-500/10 text-amber-700",
  neutral: "bg-muted text-muted-foreground",
};

export function DashboardMetricCard({
  label,
  value,
  note,
  tone,
  icon,
}: {
  label: string;
  value: string;
  note: string;
  tone: string;
  icon: ReactNode;
}) {
  return (
    <Card className="min-h-25 flex-row items-center gap-3 p-4 py-4 shadow-sm">
      <span
        className={cn(
          "grid size-10 shrink-0 place-items-center rounded-xl",
          metricToneClasses[tone] ?? metricToneClasses.neutral,
        )}
      >
        {icon}
      </span>
      <div className="flex min-w-0 flex-col">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <strong className="mt-1 text-2xl leading-none font-semibold tracking-tight text-foreground">{value}</strong>
        <small className="mt-1.5 truncate text-xs text-muted-foreground/80">{note}</small>
      </div>
    </Card>
  );
}

export function DashboardHorizontalBars({
  items,
}: {
  items: DashboardChartItem[];
}) {
  const data = items.map((item, index) => ({
    ...item,
    fill: item.color ?? chartColors[index % chartColors.length],
  }));

  return (
    <ChartContainer
      aria-label="Distribuição de tickets"
      className="h-48 w-full aspect-auto"
      config={horizontalChartConfig}
      initialDimension={{ width: 420, height: 192 }}
    >
      <BarChart
        accessibilityLayer
        data={data}
        layout="vertical"
        margin={{ left: 8, right: 24 }}
      >
        <CartesianGrid horizontal={false} strokeDasharray="3 3" />
        <XAxis axisLine={false} dataKey="value" tickLine={false} type="number" />
        <YAxis
          axisLine={false}
          dataKey="label"
          tickLine={false}
          tickMargin={8}
          type="category"
          width={104}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              formatter={(value, _name, item) => {
                const count = typeof value === "number" ? value : Number(value);
                return (
                  <>
                    <span
                      aria-hidden="true"
                      className="size-2.5 shrink-0 rounded-[3px]"
                      style={{ backgroundColor: item.payload.fill }}
                    />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <strong className="truncate font-medium text-foreground">
                        {String(item.payload.label ?? "Tickets")}
                      </strong>
                      <small className="text-xs text-muted-foreground">
                        Quantidade de tickets
                      </small>
                    </span>
                    <b className="font-mono text-sm font-semibold tabular-nums text-foreground">
                      {Number.isFinite(count)
                        ? count.toLocaleString("pt-BR")
                        : String(value)}
                    </b>
                  </>
                );
              }}
              hideIndicator
              hideLabel
            />
          }
          cursor={{ fill: "var(--surface-muted)" }}
        />
        <Bar dataKey="value" radius={[0, 5, 5, 0]}>
          {data.map((item) => (
            <Cell fill={item.fill} key={item.label} />
          ))}
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}

export function DashboardStatusDonut({
  items,
}: {
  items: DashboardChartItem[];
}) {
  const data = items
    .filter((item) => item.value > 0)
    .map((item, index) => ({
      ...item,
      fill: item.color ?? chartColors[index % chartColors.length],
    }));
  const total = data.reduce((sum, item) => sum + item.value, 0);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const activeItem = activeIndex === null ? null : data[activeIndex] ?? null;

  return (
    <div
      aria-label="Distribuição por status"
      className="grid min-h-48 items-center gap-4 sm:grid-cols-[176px_minmax(0,1fr)]"
    >
      <div className="relative mx-auto size-44 shrink-0">
        <ChartContainer
          className="size-full aspect-square"
          config={horizontalChartConfig}
          initialDimension={{ width: 176, height: 176 }}
        >
          <PieChart accessibilityLayer>
            <Pie
              data={data}
              dataKey="value"
              innerRadius={48}
              nameKey="label"
              outerRadius={76}
              paddingAngle={2}
              stroke="var(--card)"
              strokeWidth={3}
              onMouseEnter={(_entry, index) => setActiveIndex(index)}
              onMouseLeave={() => setActiveIndex(null)}
            >
              {data.map((item) => (
                <Cell fill={item.fill} key={item.label} />
              ))}
            </Pie>
          </PieChart>
        </ChartContainer>
        <div className="pointer-events-none absolute inset-0 grid place-items-center px-11 text-center">
          <span className="flex min-w-0 max-w-full flex-col items-center">
            <strong className="text-2xl leading-none font-semibold tracking-tight text-foreground">
              {(activeItem?.value ?? total).toLocaleString("pt-BR")}
            </strong>
            <small className="mt-1 line-clamp-2 max-w-20 text-xs leading-tight font-medium text-muted-foreground">
              {activeItem?.label ?? "tickets"}
            </small>
          </span>
        </div>
      </div>

      <div aria-label="Legenda dos status" className="grid gap-1.5" role="list">
        {data.map((item) => {
          const percentage = total ? Math.round((item.value / total) * 100) : 0;
          return (
            <div
              className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-muted/60"
              key={item.label}
              role="listitem"
            >
              <span
                aria-hidden="true"
                className="size-2.5 rounded-full"
                style={{ backgroundColor: item.fill }}
              />
              <span className="min-w-0 truncate text-xs font-medium text-foreground">
                {item.label}
              </span>
              <span className="flex items-baseline gap-1.5">
                <b className="text-sm font-semibold tabular-nums text-foreground">
                  {item.value.toLocaleString("pt-BR")}
                </b>
                <small className="w-7 text-right text-xs tabular-nums text-muted-foreground">
                  {percentage}%
                </small>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function DashboardDailyChart({
  data,
}: {
  data: DashboardData["ticketsByDay"];
}) {
  const compactDates = data.length > 14;
  return (
    <div
      aria-label="Gráfico de tickets criados e resolvidos por dia"
      className="w-full overflow-x-auto rounded-md focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:outline-none"
      tabIndex={compactDates ? 0 : undefined}
    >
      <ChartContainer
        className="h-48 w-full aspect-auto"
        config={dailyChartConfig}
        initialDimension={{ width: 720, height: 192 }}
        style={compactDates ? { minWidth: `${data.length * 38}px` } : undefined}
      >
        <BarChart accessibilityLayer data={data} margin={{ left: 0, right: 8 }}>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis
            axisLine={false}
            dataKey="date"
            tickFormatter={(value: string) =>
              new Intl.DateTimeFormat(
                "pt-BR",
                compactDates
                  ? { day: "2-digit", month: "2-digit", timeZone: "UTC" }
                  : { weekday: "short", timeZone: "UTC" },
              )
                .format(new Date(`${value}T12:00:00Z`))
                .replace(".", "")
            }
            tickLine={false}
            tickMargin={10}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={(value) =>
                  new Intl.DateTimeFormat("pt-BR", {
                    dateStyle: "medium",
                    timeZone: "UTC",
                  }).format(new Date(`${String(value)}T12:00:00Z`))
                }
              />
            }
          />
          <Bar
            dataKey="created"
            fill="var(--color-created)"
            radius={[4, 4, 0, 0]}
          />
          <Bar
            dataKey="resolved"
            fill="var(--color-resolved)"
            radius={[4, 4, 0, 0]}
          />
        </BarChart>
      </ChartContainer>
    </div>
  );
}
