"use client";

import { Input } from "@/app/components/ui/input";
import { Checkbox } from "@/app/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/app/components/ui/select";
import { LoaderCircle, Plus, Save, Trash2, UsersRound, X } from "lucide-react";
import { type FormEvent, useState } from "react";
import { createSettingsUser, deleteSettingsUser, updateSettingsUser, type SettingsRole, type SettingsUser } from "@/app/lib/settings";
import { Button } from "@/app/components/ui/button";
import { inputClass, SectionLayout, Field, PermissionNotice, EmptySettingsState, RoleBadge, initials, formatDate, errorMessage } from "../settings-support";

function roleChoices(allowPrivileged: boolean, currentRole?: SettingsRole) {
  return [
    { value: "viewer" as const, label: "Visualizador" },
    { value: "operator" as const, label: "Operador" },
    ...(allowPrivileged || currentRole === "admin" ? [{ value: "admin" as const, label: "Administrador" }] : []),
    ...(allowPrivileged || currentRole === "owner" ? [{ value: "owner" as const, label: "Proprietário" }] : []),
  ];
}

export function UsersSection({
  users,
  currentUserId,
  currentUserRole,
  onChange,
  onFeedback,
}: {
  users: SettingsUser[];
  currentUserId: string;
  currentUserRole: SettingsRole;
  onChange(value: SettingsUser[]): void;
  onFeedback(tone: "success" | "error", message: string): void;
}) {
  const canManage = currentUserRole === "owner" || currentUserRole === "admin";
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [createDraft, setCreateDraft] = useState({
    displayName: "",
    username: "",
    password: "",
    role: "operator" as SettingsRole,
  });
  const [editDraft, setEditDraft] = useState({
    displayName: "",
    username: "",
    role: "operator" as SettingsRole,
    active: true,
  });

  function beginEdit(user: SettingsUser) {
    setEditingId(user.id);
    setEditDraft({
      displayName: user.displayName,
      username: user.username,
      role: user.role,
      active: user.active,
    });
  }

  async function createUser(event: FormEvent) {
    event.preventDefault();
    setBusyId("new");
    try {
      const created = await createSettingsUser({
        displayName: createDraft.displayName.trim(),
        username: createDraft.username.trim(),
        password: createDraft.password,
        role: createDraft.role,
      });
      onChange([...users, created]);
      setCreateDraft({ displayName: "", username: "", password: "", role: "operator" });
      setCreating(false);
      onFeedback("success", `A conta de ${created.displayName} foi criada nesta instalação.`);
    } catch (cause) {
      onFeedback("error", errorMessage(cause));
    } finally {
      setBusyId(null);
    }
  }

  async function saveUser(userId: string) {
    setBusyId(userId);
    try {
      const targetIsCurrentUser = userId === currentUserId;
      const saved = await updateSettingsUser(userId, {
        displayName: editDraft.displayName.trim(),
        username: editDraft.username.trim(),
        ...(!targetIsCurrentUser
          ? { role: editDraft.role, active: editDraft.active }
          : {}),
      });
      onChange(users.map((user) => (user.id === userId ? saved : user)));
      setEditingId(null);
      onFeedback("success", "As permissões e os dados do usuário foram atualizados.");
    } catch (cause) {
      onFeedback("error", errorMessage(cause));
    } finally {
      setBusyId(null);
    }
  }

  async function removeUser(user: SettingsUser) {
    if (!window.confirm(`Excluir a conta local de ${user.displayName}? Esta ação não remove tickets nem mensagens.`)) return;
    setBusyId(user.id);
    try {
      await deleteSettingsUser(user.id);
      onChange(users.filter((item) => item.id !== user.id));
      onFeedback("success", "A conta foi excluída. O histórico operacional permaneceu preservado.");
    } catch (cause) {
      onFeedback("error", errorMessage(cause));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <SectionLayout
      action={
        canManage && !creating ? (
          <Button  onClick={() => setCreating(true)} type="button">
            <Plus size={16} /> Novo usuário
          </Button>
        ) : null
      }
      description="Contas e níveis de acesso armazenados somente nesta instalação."
      icon={UsersRound}
      title="Usuários locais"
    >
      {!canManage ? <PermissionNotice /> : null}
      {creating ? (
        <form className="mb-6 rounded-2xl border border-primary/20 bg-accent p-4 sm:p-5" onSubmit={createUser}>
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <h3 className="font-semibold text-foreground">Criar conta local</h3>
              <p className="mt-1 text-xs text-muted-foreground">A senha nunca é exibida novamente.</p>
            </div>
            <Button aria-label="Cancelar criação" onClick={() => setCreating(false)} size="icon-sm" type="button" variant="ghost"><X size={16} /></Button>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Nome">
              <Input autoComplete="name" className={inputClass} onChange={(event) => setCreateDraft((current) => ({ ...current, displayName: event.target.value }))} required value={createDraft.displayName} />
            </Field>
            <Field label="Usuário">
              <Input autoComplete="username" className={inputClass} onChange={(event) => setCreateDraft((current) => ({ ...current, username: event.target.value }))} required value={createDraft.username} />
            </Field>
            <Field label="Senha inicial" hint="Use pelo menos 12 caracteres.">
              <Input autoComplete="new-password" className={inputClass} minLength={12} onChange={(event) => setCreateDraft((current) => ({ ...current, password: event.target.value }))} required type="password" value={createDraft.password} />
            </Field>
            <Field label="Permissão">
              <Select onValueChange={(value) => setCreateDraft((current) => ({ ...current, role: value as SettingsRole }))} value={createDraft.role}>
                <SelectTrigger className={inputClass}><SelectValue /></SelectTrigger>
                <SelectContent>{roleChoices(currentUserRole === "owner").map((role) => <SelectItem key={role.value} value={role.value}>{role.label}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setCreating(false)} type="button">Cancelar</Button>
            <Button  disabled={busyId === "new"} type="submit">
              {busyId === "new" ? <LoaderCircle className="animate-spin" size={16} /> : <Plus size={16} />}
              Criar usuário
            </Button>
          </div>
        </form>
      ) : null}

      <div className="divide-y divide-border/70 overflow-hidden rounded-2xl border border-border bg-card">
        {users.length === 0 ? (
          <EmptySettingsState icon={UsersRound} title={canManage ? "Nenhum usuário encontrado" : "Acesso restrito"} description={canManage ? "Crie a primeira conta adicional para trabalhar em equipe." : "Somente proprietários e administradores podem consultar contas locais."} />
        ) : (
          users.map((user) => {
            const editing = editingId === user.id;
            const targetIsCurrentUser = user.id === currentUserId;
            const canManageTarget =
              currentUserRole === "owner" ||
              (currentUserRole === "admin" &&
                user.role !== "owner" &&
                user.role !== "admin") ||
              targetIsCurrentUser;
            return (
              <article className="p-4 sm:p-5" key={user.id}>
                {editing ? (
                  <div className="space-y-4">
                    <div className="grid gap-4 md:grid-cols-2">
                      <Field label="Nome"><Input className={inputClass} onChange={(event) => setEditDraft((current) => ({ ...current, displayName: event.target.value }))} value={editDraft.displayName} /></Field>
                      <Field label="Usuário"><Input className={inputClass} onChange={(event) => setEditDraft((current) => ({ ...current, username: event.target.value }))} value={editDraft.username} /></Field>
                      <Field label="Permissão"><Select disabled={targetIsCurrentUser} onValueChange={(value) => setEditDraft((current) => ({ ...current, role: value as SettingsRole }))} value={editDraft.role}><SelectTrigger className={inputClass}><SelectValue /></SelectTrigger><SelectContent>{roleChoices(currentUserRole === "owner", editDraft.role).map((role) => <SelectItem key={role.value} value={role.value}>{role.label}</SelectItem>)}</SelectContent></Select></Field>
                      <label className="mt-6 flex min-h-10 items-center gap-3 rounded-lg border border-border bg-muted/50 px-3 text-xs font-medium text-foreground">
                        <Checkbox checked={editDraft.active} disabled={targetIsCurrentUser} onCheckedChange={(checked) => setEditDraft((current) => ({ ...current, active: checked === true }))} />
                        Permitir acesso a esta instalação
                      </label>
                    </div>
                    <div className="flex flex-wrap justify-end gap-2">
                      <Button variant="outline" onClick={() => setEditingId(null)} type="button">Cancelar</Button>
                      <Button  disabled={busyId === user.id} onClick={() => void saveUser(user.id)} type="button">
                        {busyId === user.id ? <LoaderCircle className="animate-spin" size={15} /> : <Save size={15} />} Salvar
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent font-bold text-primary">{initials(user.displayName)}</span>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="truncate font-semibold text-foreground">{user.displayName}</h3>
                          <RoleBadge role={user.role} />
                          {!user.active ? <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-semibold text-destructive">Desativado</span> : null}
                          {user.lockedUntil ? <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-800">Bloqueado temporariamente</span> : null}
                        </div>
                        <p className="mt-1 truncate text-xs text-muted-foreground">@{user.username} · {user.lastLoginAt ? `Último acesso ${formatDate(user.lastLoginAt)}` : "Ainda não acessou"}</p>
                      </div>
                    </div>
                    {canManage && canManageTarget ? (
                      <div className="flex shrink-0 flex-wrap gap-2">
                        <Button variant="outline" onClick={() => beginEdit(user)} type="button">Editar</Button>
                        {!targetIsCurrentUser ? <Button aria-label={`Excluir ${user.displayName}`} size="sm" variant="destructive" disabled={busyId === user.id} onClick={() => void removeUser(user)} type="button"><Trash2 size={14} /></Button> : null}
                      </div>
                    ) : null}
                  </div>
                )}
              </article>
            );
          })
        )}
      </div>
    </SectionLayout>
  );
}
