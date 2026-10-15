"use client";

import { Input } from "@/app/components/ui/input";
import { Building2, CalendarDays, Check, Clock3, LoaderCircle, Monitor, Moon, Palette, Plus, Save, Sun, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { DEFAULT_WORK_SCHEDULE, updateWorkspaceSettings, type WorkDaySchedule, type WorkSchedule, type WorkTimePeriod, type WorkspaceSettings } from "@/app/lib/settings";
import { Button } from "@/app/components/ui/button";
import { useTheme } from "@/app/components/theme/theme-provider";
import { cn } from "@/app/lib/utils";
import type { ThemePreference } from "@/app/lib/theme";
import { inputClass, SectionLayout, Field, PermissionNotice, errorMessage } from "../settings-support";

const WEEK_DAYS = [
  { value: 1, short: "Seg", label: "segunda-feira" },
  { value: 2, short: "Ter", label: "terça-feira" },
  { value: 3, short: "Qua", label: "quarta-feira" },
  { value: 4, short: "Qui", label: "quinta-feira" },
  { value: 5, short: "Sex", label: "sexta-feira" },
  { value: 6, short: "Sáb", label: "sábado" },
  { value: 7, short: "Dom", label: "domingo" },
];

function selectWorkDays(schedule: WorkSchedule, dayNumbers: number[]): WorkSchedule {
  const existing = new Map(schedule.days.map((day) => [day.dayOfWeek, day.periods]));
  const template = schedule.days[0]?.periods ?? DEFAULT_WORK_SCHEDULE.days[0]!.periods;
  return {
    days: [...new Set(dayNumbers)]
      .sort((a, b) => a - b)
      .map((dayOfWeek) => ({
        dayOfWeek,
        periods: (existing.get(dayOfWeek) ?? template).map((period) => ({ ...period })),
      })),
  };
}

function timeToMinutes(time: string): number {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

function minutesToTime(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function canAddWorkPeriod(day: WorkDaySchedule): boolean {
  if (day.periods.length >= 4) return false;
  if (day.periods.length === 1 && timeToMinutes(day.periods[0]!.endTime) - timeToMinutes(day.periods[0]!.startTime) >= 240) return true;
  const lastPeriod = day.periods[day.periods.length - 1];
  return Boolean(lastPeriod && timeToMinutes(lastPeriod.endTime) + 120 <= 1439);
}

function addWorkPeriod(day: WorkDaySchedule): WorkDaySchedule {
  if (!canAddWorkPeriod(day)) return day;
  const longPeriodIndex = day.periods.length === 1 &&
    timeToMinutes(day.periods[0]!.endTime) - timeToMinutes(day.periods[0]!.startTime) >= 240
    ? 0
    : -1;
  if (longPeriodIndex >= 0) {
    const longPeriod = day.periods[longPeriodIndex]!;
    const start = timeToMinutes(longPeriod.startTime);
    const end = timeToMinutes(longPeriod.endTime);
    const breakStart = Math.min(end - 120, Math.max(start + 120, 12 * 60));
    const periods = [...day.periods];
    periods.splice(longPeriodIndex, 1,
      { startTime: longPeriod.startTime, endTime: minutesToTime(breakStart) },
      { startTime: minutesToTime(breakStart + 60), endTime: longPeriod.endTime },
    );
    return { ...day, periods };
  }

  const lastPeriod = day.periods[day.periods.length - 1]!;
  const start = timeToMinutes(lastPeriod.endTime) + 60;
  return {
    ...day,
    periods: [...day.periods, { startTime: minutesToTime(start), endTime: minutesToTime(start + 60) }],
  };
}

function isScheduleValid(schedule: WorkSchedule): boolean {
  return schedule.days.every((day, index) =>
    day.periods.length > 0 &&
    day.periods.length <= 4 &&
    (index === 0 || schedule.days[index - 1]!.dayOfWeek < day.dayOfWeek) &&
    day.periods.every((period, periodIndex) =>
      period.startTime < period.endTime &&
      (periodIndex === 0 || day.periods[periodIndex - 1]!.endTime <= period.startTime),
    ),
  );
}

function updateDayPeriods(
  schedule: WorkSchedule,
  dayOfWeek: number,
  update: (day: WorkDaySchedule) => WorkDaySchedule,
): WorkSchedule {
  return {
    days: schedule.days.map((day) => day.dayOfWeek === dayOfWeek ? update(day) : day),
  };
}

function updatePeriod(
  day: WorkDaySchedule,
  periodIndex: number,
  changes: Partial<WorkTimePeriod>,
): WorkDaySchedule {
  return {
    ...day,
    periods: day.periods.map((period, index) => index === periodIndex ? { ...period, ...changes } : period),
  };
}

const THEME_OPTIONS: Array<{
  value: ThemePreference;
  title: string;
  description: string;
  icon: typeof Sun;
}> = [
  {
    value: "light",
    title: "Claro",
    description: "Mantém superfícies claras em qualquer horário.",
    icon: Sun,
  },
  {
    value: "dark",
    title: "Escuro",
    description: "Reduz o brilho sem perder contraste e hierarquia.",
    icon: Moon,
  },
  {
    value: "system",
    title: "Sistema",
    description: "Acompanha automaticamente a aparência do macOS.",
    icon: Monitor,
  },
];

export function GeneralSection({
  workspace,
  canManage,
  onChange,
  onFeedback,
}: {
  workspace: WorkspaceSettings | null;
  canManage: boolean;
  onChange(value: WorkspaceSettings): void;
  onFeedback(tone: "success" | "error", message: string): void;
}) {
  const { resolvedTheme, setTheme, theme } = useTheme();
  const [draft, setDraft] = useState<WorkspaceSettings>(
    workspace ?? {
      organizationName: "",
      workspaceName: "",
      timezone: "UTC",
      workSchedule: DEFAULT_WORK_SCHEDULE,
    },
  );
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canManage) return;
    setSaving(true);
    try {
      const saved = await updateWorkspaceSettings({
        organizationName: draft.organizationName.trim(),
        workspaceName: draft.workspaceName.trim(),
        timezone: draft.timezone.trim(),
        workSchedule: {
          days: [...draft.workSchedule.days]
            .sort((a, b) => a.dayOfWeek - b.dayOfWeek)
            .map((day) => ({
              ...day,
              periods: [...day.periods].sort((a, b) => a.startTime.localeCompare(b.startTime)),
            })),
        },
      });
      onChange(saved);
      onFeedback("success", "A identidade, o fuso horário e os horários de trabalho foram atualizados.");
    } catch (cause) {
      onFeedback("error", errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <SectionLayout
        description="Defina como esta instalação aparece para sua equipe."
        icon={Building2}
        title="Identidade do workspace"
      >
        {!canManage ? <PermissionNotice /> : null}
        <form className="space-y-6" onSubmit={submit}>
          <fieldset className="space-y-5" disabled={!canManage || saving}>
            <div className="grid gap-5 md:grid-cols-2">
              <Field label="Organização" hint="Nome da empresa ou operação responsável.">
                <Input
                  className={inputClass}
                  onChange={(event) => setDraft((current) => ({ ...current, organizationName: event.target.value }))}
                  placeholder="Ex.: Minha empresa"
                  required
                  value={draft.organizationName}
                />
              </Field>
              <Field label="Nome do workspace" hint="Exibido na navegação e na tela de acesso.">
                <Input
                  className={inputClass}
                  onChange={(event) => setDraft((current) => ({ ...current, workspaceName: event.target.value }))}
                  placeholder="Ex.: Suporte"
                  required
                  value={draft.workspaceName}
                />
              </Field>
              <Field label="Fuso horário" hint="Datas continuam armazenadas em UTC e são convertidas apenas para exibição.">
                <Input
                  className={inputClass}
                  onChange={(event) => setDraft((current) => ({ ...current, timezone: event.target.value }))}
                  placeholder="America/Sao_Paulo"
                  required
                  value={draft.timezone}
                />
              </Field>
            </div>

            <div className="rounded-2xl border border-border/80 bg-muted/20 p-4 sm:p-5">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex items-start gap-3">
                  <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
                    <CalendarDays size={19} />
                  </span>
                  <div>
                    <h3 className="text-sm font-semibold text-foreground">Seu horário de trabalho</h3>
                    <p className="mt-1 max-w-xl text-xs leading-5 text-muted-foreground">
                      Defina seus dias e horários. Você pode adicionar mais de um período por dia, por exemplo, manhã e tarde.
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 gap-2 pl-[52px] sm:pl-0">
                  <button
                    className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => setDraft((current) => ({
                      ...current,
                      workSchedule: selectWorkDays(current.workSchedule, [1, 2, 3, 4, 5]),
                    }))}
                    type="button"
                  >
                    Seg a sex
                  </button>
                  <button
                    className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => setDraft((current) => ({
                      ...current,
                      workSchedule: selectWorkDays(current.workSchedule, WEEK_DAYS.map((day) => day.value)),
                    }))}
                    type="button"
                  >
                    Todos os dias
                  </button>
                </div>
              </div>

              <div className="mt-5">
                <p className="mb-2.5 text-xs font-medium text-muted-foreground">Dias em que trabalha <span className="font-normal">· deixe todos desmarcados para desativar</span></p>
                <div aria-label="Dias de trabalho" className="grid grid-cols-4 gap-2 sm:grid-cols-7" role="group">
                  {WEEK_DAYS.map((day) => {
                    const selected = draft.workSchedule.days.some((entry) => entry.dayOfWeek === day.value);
                    return (
                      <button
                        aria-label={`${day.label}, ${selected ? "selecionado" : "não selecionado"}`}
                        aria-pressed={selected}
                        className={cn(
                          "inline-flex h-10 items-center justify-center gap-1.5 rounded-xl border px-2 text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          selected
                            ? "border-primary bg-primary text-primary-foreground shadow-sm"
                            : "border-border bg-background text-muted-foreground hover:border-primary/40 hover:text-foreground",
                        )}
                        key={day.value}
                        onClick={() => setDraft((current) => {
                          const days = current.workSchedule.days.map((entry) => entry.dayOfWeek);
                          const nextDays = days.includes(day.value)
                            ? days.filter((value) => value !== day.value)
                            : [...days, day.value];
                          return {
                            ...current,
                            workSchedule: selectWorkDays(current.workSchedule, nextDays),
                          };
                        })}
                        type="button"
                      >
                        {selected ? <Check aria-hidden="true" size={14} strokeWidth={2.5} /> : null}
                        {day.short}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div aria-label="Horários dos dias de trabalho" className="mt-5 space-y-3">
                <div className="mb-3">
                  <h4 className="text-xs font-semibold text-foreground">Horários por dia</h4>
                  <p className="mt-1 text-xs text-muted-foreground">Cada dia pode ter horários diferentes e vários períodos.</p>
                </div>
                {draft.workSchedule.days.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-border bg-background/60 px-4 py-5 text-center">
                    <CalendarDays aria-hidden="true" className="mx-auto text-muted-foreground" size={19} />
                    <p className="mt-2 text-sm font-medium text-foreground">Horário de trabalho desativado</p>
                    <p className="mt-1 text-xs text-muted-foreground">Selecione um ou mais dias se quiser configurar seus períodos.</p>
                  </div>
                ) : null}
                {draft.workSchedule.days.map((daySchedule) => {
                  const day = WEEK_DAYS.find((entry) => entry.value === daySchedule.dayOfWeek)!;
                  const dayHasInvalidPeriod = daySchedule.periods.some((period, periodIndex) =>
                    period.startTime >= period.endTime ||
                    (periodIndex > 0 && daySchedule.periods[periodIndex - 1]!.endTime > period.startTime),
                  );
                  return (
                    <section className="rounded-xl border border-border/80 bg-background/80 p-3 sm:p-4" key={day.value}>
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <h5 className="text-sm font-semibold capitalize text-foreground">{day.label}</h5>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {daySchedule.periods.length} {daySchedule.periods.length === 1 ? "período" : "períodos"}
                          </p>
                        </div>
                        <Button
                          disabled={!canAddWorkPeriod(daySchedule)}
                          onClick={() => setDraft((current) => ({
                            ...current,
                            workSchedule: updateDayPeriods(current.workSchedule, day.value, addWorkPeriod),
                          }))}
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          <Plus size={15} /> Adicionar período
                        </Button>
                      </div>

                      <div className="mt-3 space-y-2.5">
                        {daySchedule.periods.map((period, periodIndex) => {
                          const periodIsInvalid = period.startTime >= period.endTime ||
                            (periodIndex > 0 && daySchedule.periods[periodIndex - 1]!.endTime > period.startTime) ||
                            (periodIndex < daySchedule.periods.length - 1 && period.endTime > daySchedule.periods[periodIndex + 1]!.startTime);
                          return (
                            <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto] items-end gap-2" key={`${day.value}-${periodIndex}`}>
                              <label className="min-w-0 space-y-1">
                                <span className="block text-[11px] font-medium text-muted-foreground">Início</span>
                                <span className="relative block">
                                  <Clock3 aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={15} />
                                  <Input
                                    aria-label={`${day.label}, início do período ${periodIndex + 1}`}
                                    aria-invalid={periodIsInvalid}
                                    className={cn(inputClass, "pl-9")}
                                    onChange={(event) => setDraft((current) => ({
                                      ...current,
                                      workSchedule: updateDayPeriods(current.workSchedule, day.value, (entry) => updatePeriod(entry, periodIndex, { startTime: event.target.value })),
                                    }))}
                                    required
                                    type="time"
                                    value={period.startTime}
                                  />
                                </span>
                              </label>
                              <span aria-hidden="true" className="pb-2 text-xs text-muted-foreground">até</span>
                              <label className="min-w-0 space-y-1">
                                <span className="block text-[11px] font-medium text-muted-foreground">Término</span>
                                <span className="relative block">
                                  <Clock3 aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={15} />
                                  <Input
                                    aria-label={`${day.label}, término do período ${periodIndex + 1}`}
                                    aria-invalid={periodIsInvalid}
                                    className={cn(inputClass, "pl-9")}
                                    onChange={(event) => setDraft((current) => ({
                                      ...current,
                                      workSchedule: updateDayPeriods(current.workSchedule, day.value, (entry) => updatePeriod(entry, periodIndex, { endTime: event.target.value })),
                                    }))}
                                    required
                                    type="time"
                                    value={period.endTime}
                                  />
                                </span>
                              </label>
                              <button
                                aria-label={`Remover período ${periodIndex + 1} de ${day.label}`}
                                className={cn(
                                  "mb-0.5 grid size-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                  daySchedule.periods.length === 1 && "invisible",
                                )}
                                disabled={daySchedule.periods.length === 1}
                                onClick={() => setDraft((current) => ({
                                  ...current,
                                  workSchedule: updateDayPeriods(current.workSchedule, day.value, (entry) => ({
                                    ...entry,
                                    periods: entry.periods.filter((_, index) => index !== periodIndex),
                                  })),
                                }))}
                                type="button"
                              >
                                <Trash2 aria-hidden="true" size={15} />
                              </button>
                            </div>
                          );
                        })}
                      </div>
                      {dayHasInvalidPeriod ? (
                        <p className="mt-2 text-xs text-destructive">Os períodos precisam estar em ordem e sem sobreposição.</p>
                      ) : null}
                    </section>
                  );
                })}
              </div>
              {!isScheduleValid(draft.workSchedule) ? (
                <p className="mt-3 text-xs text-destructive">Corrija os horários para salvar. Os períodos não podem se sobrepor.</p>
              ) : null}
            </div>
          </fieldset>
          {canManage ? (
            <div className="flex justify-end border-t border-border/70 pt-5">
              <Button
                className="w-full sm:w-auto"
                disabled={saving || !draft.organizationName.trim() || !draft.workspaceName.trim() || !draft.timezone.trim() || !isScheduleValid(draft.workSchedule)}
                type="submit"
              >
                {saving ? <LoaderCircle className="animate-spin" size={16} /> : <Save size={16} />}
                Salvar alterações
              </Button>
            </div>
          ) : null}
        </form>
      </SectionLayout>

      <SectionLayout
        description="Escolha como o Threadmark aparece nesta máquina. A preferência fica salva neste app."
        icon={Palette}
        title="Aparência"
      >
        <div className="grid gap-3 md:grid-cols-3" role="radiogroup" aria-label="Tema do Threadmark">
          {THEME_OPTIONS.map((option) => {
            const Icon = option.icon;
            const selected = theme === option.value;
            return (
              <Button
                aria-checked={selected}
                className={cn(
                  "group h-auto flex-col items-stretch justify-start whitespace-normal rounded-xl border bg-card p-4 text-left transition-colors hover:border-primary/50 hover:bg-accent/50",
                  selected && "border-primary bg-primary/5 ring-2 ring-primary/15",
                )}
                key={option.value}
                onClick={() => setTheme(option.value)}
                role="radio"
                type="button"
                variant="outline"
              >
                <span
                  className={cn(
                    "grid size-10 place-items-center rounded-xl bg-muted text-muted-foreground transition-colors group-hover:text-foreground",
                    selected && "bg-primary/10 text-primary",
                  )}
                >
                  <Icon size={18} />
                </span>
                <strong className="mt-3 block text-sm font-semibold text-foreground">{option.title}</strong>
                <span className="mt-1 block text-xs leading-5 text-muted-foreground">{option.description}</span>
                {option.value === "system" && selected ? (
                  <span className="mt-3 block text-xs font-medium text-primary">
                    Usando tema {resolvedTheme === "dark" ? "escuro" : "claro"}
                  </span>
                ) : null}
              </Button>
            );
          })}
        </div>
      </SectionLayout>
    </div>
  );
}
