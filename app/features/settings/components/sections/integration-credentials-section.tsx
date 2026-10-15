"use client";

import { Copy, KeyRound, LoaderCircle, Plus, ShieldOff } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import {
  createIntegrationCredential,
  getIntegrationCredentials,
  revokeIntegrationCredential,
  type IntegrationCredential,
} from "@/app/lib/settings";
import {
  errorMessage,
  Field,
  inputClass,
  Notice,
  SectionLayout,
} from "../settings-support";
import { CliSetupGuide } from "./cli-setup-guide";

export function IntegrationCredentialsSection({
  canManage,
  onFeedback,
}: {
  canManage: boolean;
  onFeedback(tone: "success" | "error", message: string): void;
}) {
  const [credentials, setCredentials] = useState<IntegrationCredential[]>([]);
  const [name, setName] = useState("CLI no meu computador");
  const [expiresOn, setExpiresOn] = useState(defaultExpiryDate());
  const [issuedToken, setIssuedToken] = useState<{
    credentialId: string;
    token: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [referenceTime, setReferenceTime] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const refreshClock = window.setInterval(() => setReferenceTime(Date.now()), 60_000);
    void getIntegrationCredentials()
      .then((items) => {
        if (!cancelled) {
          setCredentials(items);
          setReferenceTime(Date.now());
        }
      })
      .catch((cause) => {
        if (!cancelled) onFeedback("error", errorMessage(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      window.clearInterval(refreshClock);
    };
  }, [onFeedback]);

  async function createCredential() {
    setCreating(true);
    try {
      const issued = await createIntegrationCredential({
        name,
        expiresAt: expiresOn ? `${expiresOn}T23:59:59.000Z` : null,
      });
      setCredentials((current) => [
        issued.credential,
        ...current.filter((item) => item.id !== issued.credential.id),
      ]);
      setIssuedToken({
        credentialId: issued.credential.id,
        token: issued.token,
      });
      setReferenceTime(Date.now());
      onFeedback(
        "success",
        "Credencial criada. Copie o token agora; ele não será exibido novamente.",
      );
    } catch (cause) {
      onFeedback("error", errorMessage(cause));
    } finally {
      setCreating(false);
    }
  }

  async function revokeCredential(credential: IntegrationCredential) {
    setRevokingId(credential.id);
    try {
      const revoked = await revokeIntegrationCredential(credential.id);
      setCredentials((current) =>
        current.map((item) => (item.id === revoked.id ? revoked : item)),
      );
      setIssuedToken((current) =>
        current?.credentialId === credential.id ? null : current,
      );
      onFeedback("success", `Credencial “${credential.name}” revogada.`);
    } catch (cause) {
      onFeedback("error", errorMessage(cause));
    } finally {
      setRevokingId(null);
    }
  }

  async function copyToken() {
    if (!issuedToken) return;
    try {
      await navigator.clipboard.writeText(issuedToken.token);
      onFeedback("success", "Token copiado. Execute `threadmark remote login production`.");
    } catch {
      onFeedback("error", "Não foi possível copiar o token automaticamente.");
    }
  }

  return (
    <SectionLayout
      description="Conecte o Codex ou outro agente ao Threadmark pela linha de comando."
      icon={KeyRound}
      title="CLI"
    >
      <div className="space-y-5">
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_180px_auto] md:items-end">
          <Field label="Nome da credencial">
            <Input
              className={inputClass}
              disabled={!canManage}
              maxLength={100}
              onChange={(event) => setName(event.target.value)}
              placeholder="Ex.: Codex no meu computador"
              value={name}
            />
          </Field>
          <Field label="Expira em">
            <Input
              className={inputClass}
              disabled={!canManage}
              onChange={(event) => setExpiresOn(event.target.value)}
              type="date"
              value={expiresOn}
            />
          </Field>
          <Button
            disabled={!canManage || creating || !name.trim() || !expiresOn}
            onClick={() => void createCredential()}
            type="button"
          >
            {creating ? <LoaderCircle className="animate-spin" size={16} /> : <Plus size={16} />}
            Criar credencial
          </Button>
        </div>
        <p className="text-xs leading-5 text-muted-foreground">
          Use a mesma CLI com Codex ou qualquer outro agente. Após criar a credencial, você verá o token e as instruções de conexão.
        </p>

        {issuedToken ? (
          <div className="space-y-5">
            <Notice tone="success" title="Copie este token agora">
              <p className="mb-3 text-xs">
                Este token aparece uma única vez. Copie agora e siga as instruções de conexão abaixo.
              </p>
              <div className="flex gap-2">
                <Input
                  aria-label="Token de integração emitido"
                  className={`${inputClass} font-mono text-xs`}
                  readOnly
                  value={issuedToken.token}
                />
                <Button onClick={() => void copyToken()} type="button" variant="outline">
                  <Copy size={15} /> Copiar
                </Button>
              </div>
            </Notice>
            <CliSetupGuide onFeedback={onFeedback} />
          </div>
        ) : null}

        <div className="overflow-hidden rounded-2xl border border-border bg-card">
          <div className="border-b border-border/70 px-5 py-4">
            <h3 className="font-semibold text-foreground">Credenciais desta conta</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Cada credencial usa as permissões da sua conta para consultar e gerenciar atendimentos pela CLI.
            </p>
          </div>
          {loading ? (
            <div className="flex items-center gap-2 p-5 text-sm text-muted-foreground">
              <LoaderCircle className="animate-spin" size={16} /> Carregando credenciais…
            </div>
          ) : credentials.length === 0 ? (
            <p className="p-5 text-sm text-muted-foreground">Nenhuma credencial criada.</p>
          ) : (
            <div className="divide-y divide-border/70">
              {credentials.map((credential) => {
                const revoked = Boolean(credential.revokedAt);
                const expired = Boolean(
                  referenceTime > 0
                  && credential.expiresAt
                  && Date.parse(credential.expiresAt) <= referenceTime,
                );
                const stateLabel = revoked ? "Revogada" : expired ? "Expirada" : "Ativa";
                return (
                  <div className="flex flex-col justify-between gap-3 p-5 sm:flex-row sm:items-center" key={credential.id}>
                    <div>
                      <div className="flex items-center gap-2">
                        <strong className="text-sm text-foreground">{credential.name}</strong>
                        <span className={revoked || expired ? "text-xs text-destructive" : "text-xs text-emerald-600"}>
                          {stateLabel}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        CLI · Expira em {formatDate(credential.expiresAt)}
                        {credential.lastUsedAt ? ` · Último uso ${formatDate(credential.lastUsedAt)}` : " · Ainda não utilizada"}
                      </p>
                    </div>
                    <Button
                      disabled={!canManage || revoked || revokingId === credential.id}
                      onClick={() => void revokeCredential(credential)}
                      type="button"
                      variant="outline"
                    >
                      {revokingId === credential.id ? (
                        <LoaderCircle className="animate-spin" size={15} />
                      ) : (
                        <ShieldOff size={15} />
                      )}
                      Revogar
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </SectionLayout>
  );
}

function defaultExpiryDate(): string {
  const date = new Date();
  date.setDate(date.getDate() + 90);
  return date.toISOString().slice(0, 10);
}

function formatDate(value: string | null): string {
  if (!value) return "sem expiração";
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}
