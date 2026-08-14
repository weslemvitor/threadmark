"use client";

import { Input } from "@/app/components/ui/input";
import { Eye, KeyRound, LoaderCircle, LogOut, LockKeyhole, Save, Server, ShieldCheck } from "lucide-react";
import { type FormEvent, useState } from "react";
import { type SettingsRole } from "@/app/lib/settings";
import { changeLocalPassword } from "@/app/lib/access";
import { Button } from "@/app/components/ui/button";
import { inputClass, SectionLayout, Field, SecurityCard, PermissionRow, roleLabel, errorMessage } from "../settings-support";

export function SecuritySection({
  currentUserRole,
  onFeedback,
  onLogout,
}: {
  currentUserRole: SettingsRole;
  onFeedback(tone: "success" | "error", message: string): void;
  onLogout(): Promise<void>;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  async function changePassword(event: FormEvent) {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      onFeedback("error", "A confirmação da nova senha não coincide.");
      return;
    }
    setSaving(true);
    try {
      await changeLocalPassword({ currentPassword, password: newPassword });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      onFeedback("success", "Sua senha foi alterada e as sessões anteriores foram revogadas.");
    } catch (cause) {
      onFeedback("error", errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  async function logout() {
    setLoggingOut(true);
    try {
      await onLogout();
    } catch (cause) {
      setLoggingOut(false);
      onFeedback("error", errorMessage(cause));
    }
  }

  return (
    <div className="space-y-6">
    <SectionLayout description="Como esta instalação protege acessos, chaves e operações sensíveis." icon={ShieldCheck} title="Segurança local">
      <div className="grid gap-4 md:grid-cols-2">
        <SecurityCard icon={LockKeyhole} title="Sessão protegida">O navegador usa uma sessão local com cookie protegido. Sua permissão atual é <strong>{roleLabel(currentUserRole)}</strong>.</SecurityCard>
        <SecurityCard icon={KeyRound} title="Segredos write-only">Chaves de provedores são criptografadas fora do SQLite. Depois de salvar, a API informa apenas que existe uma credencial.</SecurityCard>
        <SecurityCard icon={Eye} title="WhatsApp somente leitura">A integração observa e armazena mensagens recebidas. Não existe endpoint de envio ou resposta automática.</SecurityCard>
        <SecurityCard icon={Server} title="Princípio do menor acesso">Integrações técnicas usadas em investigações devem operar em modo somente leitura e com escopo limitado.</SecurityCard>
      </div>
      <div className="mt-6 overflow-hidden rounded-2xl border border-border bg-card">
        <div className="border-b border-border/70 px-5 py-4"><h3 className="font-semibold text-foreground">Níveis de acesso</h3><p className="mt-1 text-xs text-muted-foreground">Operações continuam validadas pela API mesmo quando um controle está oculto na interface.</p></div>
        <div className="grid divide-y divide-border/70 md:grid-cols-2 md:divide-x md:divide-y-0">
          <div className="space-y-3 p-5"><PermissionRow active={currentUserRole === "owner"} label="Proprietário" description="Controle completo da instalação e das contas." /><PermissionRow active={currentUserRole === "admin"} label="Administrador" description="Gerencia workspace, equipe, IA e backups." /></div>
          <div className="space-y-3 p-5"><PermissionRow active={currentUserRole === "operator"} label="Operador" description="Trabalha nos atendimentos sem alterar integrações." /><PermissionRow active={currentUserRole === "viewer"} label="Visualizador" description="Consulta o suporte sem executar mudanças." /></div>
        </div>
      </div>
    </SectionLayout>
    <SectionLayout description="Atualize sua credencial ou encerre esta sessão do navegador." icon={KeyRound} title="Sua conta">
      <form className="space-y-5" onSubmit={changePassword}>
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Senha atual"><Input autoComplete="current-password" className={inputClass} onChange={(event) => setCurrentPassword(event.target.value)} required type="password" value={currentPassword} /></Field>
          <Field label="Nova senha" hint="Mínimo de 12 caracteres."><Input autoComplete="new-password" className={inputClass} minLength={12} onChange={(event) => setNewPassword(event.target.value)} required type="password" value={newPassword} /></Field>
          <Field label="Confirmar nova senha"><Input autoComplete="new-password" className={inputClass} minLength={12} onChange={(event) => setConfirmPassword(event.target.value)} required type="password" value={confirmPassword} /></Field>
        </div>
        <div className="flex justify-end">
          <Button className="w-full sm:w-auto" disabled={saving || newPassword.length < 12 || newPassword !== confirmPassword} type="submit">{saving ? <LoaderCircle className="animate-spin" size={16} /> : <Save size={16} />} Alterar senha</Button>
        </div>
      </form>
      <div className="mt-6 flex flex-col justify-between gap-3 border-t border-border/70 pt-5 sm:flex-row sm:items-center">
        <div><strong className="text-sm text-foreground">Encerrar sessão</strong><p className="mt-1 text-xs text-muted-foreground">O serviço local e a captura continuam rodando.</p></div>
        <Button variant="outline" disabled={loggingOut} onClick={() => void logout()} type="button">{loggingOut ? <LoaderCircle className="animate-spin" size={16} /> : <LogOut size={16} />} Sair</Button>
      </div>
    </SectionLayout>
    </div>
  );
}
