"use client";

import { Input } from "@/app/components/ui/input";
import { Building2, LoaderCircle, Save } from "lucide-react";
import { type FormEvent, useState } from "react";
import { updateWorkspaceSettings, type WorkspaceSettings } from "@/app/lib/settings";
import { Button } from "@/app/components/ui/button";
import { inputClass, SectionLayout, Field, PermissionNotice, errorMessage } from "../settings-support";

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
  );
}
