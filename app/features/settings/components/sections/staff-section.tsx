"use client";

import { Input } from "@/app/components/ui/input";
import { LoaderCircle, Plus, Save, ShieldCheck, Trash2, UserRound } from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";
import { updateStaffSettings, type StaffSettings } from "@/app/lib/settings";
import { Button } from "@/app/components/ui/button";
import { inputClass, SectionLayout, Notice, PermissionNotice, EmptySettingsState, compactIdentity, equalStringArrays, errorMessage } from "../settings-support";

export function StaffSection({
  staff,
  canManage,
  onChange,
  onFeedback,
}: {
  staff: StaffSettings;
  canManage: boolean;
  onChange(value: StaffSettings): void;
  onFeedback(tone: "success" | "error", message: string): void;
}) {
  const [identities, setIdentities] = useState(staff.identities);
  const [newIdentity, setNewIdentity] = useState("");
  const [saving, setSaving] = useState(false);

  function addIdentity(event: FormEvent) {
    event.preventDefault();
    const identity = newIdentity.trim();
    if (!identity || identities.includes(identity)) return;
    setIdentities((current) => [...current, identity]);
    setNewIdentity("");
  }

  async function save() {
    setSaving(true);
    try {
      const saved = await updateStaffSettings(identities);
      onChange(saved);
      onFeedback("success", saved.restartRequired ? "A equipe foi salva. Reinicie a captura para aplicar a nova lista no WhatsApp." : "A equipe do WhatsApp foi atualizada.");
    } catch (cause) {
      onFeedback("error", errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  const participantByIdentity = useMemo(() => {
    const entries = staff.participants.flatMap((participant) =>
      [participant.phoneE164, participant.externalJid].filter((item): item is string => Boolean(item)).map((item) => [compactIdentity(item), participant] as const),
    );
    return new Map(entries);
  }, [staff.participants]);

  return (
    <SectionLayout description="Mensagens destes números entram como contexto e nunca abrem tickets." icon={UserRound} title="Equipe do WhatsApp">
      {!canManage ? <PermissionNotice /> : null}
      {staff.restartRequired ? (
        <div className="mb-5"><Notice tone="warning" title="Reinício pendente">A captura precisa ser reiniciada para que toda a lista seja aplicada.</Notice></div>
      ) : null}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div>
          {canManage ? (
            <form className="mb-4 flex flex-col gap-2 sm:flex-row" onSubmit={addIdentity}>
              <label className="sr-only" htmlFor="new-staff-identity">Telefone ou identidade do WhatsApp</label>
              <Input
                className={`${inputClass} mt-0 flex-1`}
                id="new-staff-identity"
                onChange={(event) => setNewIdentity(event.target.value)}
                placeholder="Ex.: +55 47 99999-9999"
                value={newIdentity}
              />
              <Button variant="outline" disabled={!newIdentity.trim()} type="submit"><Plus size={15} /> Adicionar</Button>
            </form>
          ) : null}
          <div className="divide-y divide-border/70 overflow-hidden rounded-2xl border border-border bg-card">
            {identities.length === 0 ? (
              <EmptySettingsState
                description={canManage ? "Adicione os telefones usados pela sua equipe de suporte." : "Somente proprietários e administradores podem consultar a lista interna."}
                icon={UserRound}
                title={canManage ? "Nenhum número interno" : "Acesso restrito"}
              />
            ) : (
              identities.map((identity) => {
                const participant = participantByIdentity.get(compactIdentity(identity));
                return (
                  <div className="flex items-center justify-between gap-3 p-4" key={identity}>
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-emerald-50 text-emerald-700"><UserRound size={16} /></span>
                      <div className="min-w-0">
                        <strong className="block truncate text-sm text-foreground">{participant?.displayName ?? identity}</strong>
                        <span className="mt-0.5 block truncate text-xs text-muted-foreground">{participant?.phoneE164 ?? identity}{participant ? " · Identificado no histórico" : " · Aguardando correspondência"}</span>
                      </div>
                    </div>
                    {canManage ? <Button aria-label={`Remover ${identity}`} size="sm" variant="destructive" onClick={() => setIdentities((current) => current.filter((item) => item !== identity))} type="button"><Trash2 size={14} /></Button> : null}
                  </div>
                );
              })
            )}
          </div>
          {canManage ? (
            <div className="mt-5 flex justify-end">
              <Button  disabled={saving || equalStringArrays(identities, staff.identities)} onClick={() => void save()} type="button">
                {saving ? <LoaderCircle className="animate-spin" size={16} /> : <Save size={16} />} Salvar equipe
              </Button>
            </div>
          ) : null}
        </div>
        <aside className="rounded-2xl border border-primary/20 bg-accent p-5">
          <ShieldCheck className="text-primary" size={20} />
          <h3 className="mt-3 font-semibold text-foreground">Regra de captura</h3>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">O Threadmark salva as mensagens da equipe para preservar o contexto, mas só mensagens externas podem sugerir tickets.</p>
          <p className="mt-4 text-xs leading-5 text-muted-foreground">Use o número completo com DDI e DDD. Formatação, espaços e parênteses são aceitos.</p>
        </aside>
      </div>
    </SectionLayout>
  );
}
