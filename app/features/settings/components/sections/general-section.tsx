"use client";

import { Input } from "@/app/components/ui/input";
import { Building2, LoaderCircle, Monitor, Moon, Palette, Save, Sun } from "lucide-react";
import { type FormEvent, useState } from "react";
import { updateWorkspaceSettings, type WorkspaceSettings } from "@/app/lib/settings";
import { Button } from "@/app/components/ui/button";
import { useTheme } from "@/app/components/theme/theme-provider";
import { cn } from "@/app/lib/utils";
import type { ThemePreference } from "@/app/lib/theme";
import { inputClass, SectionLayout, Field, PermissionNotice, errorMessage } from "../settings-support";

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
    workspace ?? { organizationName: "", workspaceName: "", timezone: "UTC" },
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
      });
      onChange(saved);
      onFeedback("success", "A identidade e o fuso horário do workspace foram atualizados.");
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
          </fieldset>
          {canManage ? (
            <div className="flex justify-end border-t border-border/70 pt-5">
              <Button
                className="w-full sm:w-auto"
                disabled={saving || !draft.organizationName.trim() || !draft.workspaceName.trim() || !draft.timezone.trim()}
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
