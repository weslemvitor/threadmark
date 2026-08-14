"use client";

import {
  createContext,
  type FormEvent,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  ArrowRight,
  Boxes,
  CheckCircle2,
  Database,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  ShieldCheck,
} from "lucide-react";

import {
  completeLocalSetup,
  getCurrentSession,
  getSetupStatus,
  loginLocal,
  logoutLocal,
  type SessionState,
  type SetupStatus,
} from "@/app/lib/access";
import { subscribeSessionExpired } from "@/app/lib/session-events";
import { Button } from "@/app/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from "@/app/components/ui/card";
import { Input } from "@/app/components/ui/input";

type AccessContextValue = SessionState & {
  logout(): Promise<void>;
};

const AccessContext = createContext<AccessContextValue | null>(null);

export function useAppAccess(): AccessContextValue | null {
  return useContext(AccessContext);
}

export function AppAccessGate({ children }: { children: ReactNode }) {
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [session, setSession] = useState<SessionState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const status = await getSetupStatus();
        if (cancelled) return;
        setSetup(status);
        if (status.completed) {
          try {
            const current = await getCurrentSession();
            if (!cancelled) setSession(current);
          } catch {
            // A instalação existe, mas este navegador ainda precisa entrar.
          }
        }
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Falha ao abrir o Threadmark.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(
    () => subscribeSessionExpired(() => setSession(null)),
    [],
  );

  const context = useMemo<AccessContextValue | null>(
    () =>
      session
        ? {
            ...session,
            async logout() {
              try {
                await logoutLocal();
              } finally {
                setSession(null);
              }
            },
          }
        : null,
    [session],
  );

  if (loading) return <AccessLoading />;
  if (error || !setup) {
    return (
      <AccessFrame>
        <Card className="w-full max-w-md items-center py-8 text-center" role="alert">
          <ShieldCheck className="text-destructive" size={24} />
          <h1 className="px-6 text-lg font-semibold text-foreground">Não foi possível abrir o workspace</h1>
          <p className="px-6 text-sm text-muted-foreground">{error ?? "O serviço local não respondeu."}</p>
          <Button type="button" variant="outline" onClick={() => window.location.reload()}>
            Tentar novamente
          </Button>
        </Card>
      </AccessFrame>
    );
  }
  if (!setup.completed) {
    return (
      <SetupScreen
        setup={setup}
        onComplete={(nextSession) => {
          setSession(nextSession);
          setSetup((current) => (current ? { ...current, completed: true } : current));
        }}
      />
    );
  }
  if (!session || !context) {
    return <LoginScreen workspace={setup.workspace.name} onLogin={setSession} />;
  }
  return <AccessContext.Provider value={context}>{children}</AccessContext.Provider>;
}

function AccessFrame({ children }: { children: ReactNode }) {
  return (
    <main className="relative grid min-h-dvh place-items-center overflow-hidden bg-muted/40 px-4 py-16">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,hsl(var(--primary)/0.12),transparent_38%),radial-gradient(circle_at_bottom_right,hsl(var(--primary)/0.08),transparent_42%)]" aria-hidden="true" />
      <div className="absolute left-5 top-5 z-10 flex items-center gap-2.5">
        <span className="grid size-9 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm"><Boxes size={20} /></span>
        <strong className="text-sm font-semibold text-foreground">Threadmark</strong>
      </div>
      <div className="relative z-10 w-full">{children}</div>
      <p className="absolute bottom-5 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
        <LockKeyhole size={13} /> Serviço restrito à sua máquina
      </p>
    </main>
  );
}

function AccessLoading() {
  return (
    <AccessFrame>
      <div className="mx-auto grid w-full max-w-sm place-items-center gap-3 rounded-xl border border-border bg-card p-8 shadow-sm" role="status">
        <LoaderCircle className="animate-spin text-primary" size={26} />
        <strong className="text-sm text-foreground">Abrindo seu workspace local…</strong>
      </div>
    </AccessFrame>
  );
}

function SetupScreen({
  setup,
  onComplete,
}: {
  setup: SetupStatus;
  onComplete(session: SessionState): void;
}) {
  const [step, setStep] = useState(0);
  const [workspaceName, setWorkspaceName] = useState(setup.workspace.name || "Meu workspace");
  const [timezone, setTimezone] = useState(
    setup.workspace.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  );
  const [displayName, setDisplayName] = useState("");
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [bootstrapToken, setBootstrapToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (step === 0) {
      if (!workspaceName.trim() || !timezone.trim()) return;
      setStep(1);
      return;
    }
    if (password !== confirmPassword) {
      setError("As senhas não coincidem.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      onComplete(
        await completeLocalSetup({
          ...(setup.bootstrapTokenRequired
            ? { bootstrapToken: bootstrapToken.trim() }
            : {}),
          workspaceName: workspaceName.trim(),
          timezone: timezone.trim(),
          displayName: displayName.trim(),
          login: login.trim(),
          password,
        }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível concluir a configuração.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AccessFrame>
      <Card className="mx-auto w-full max-w-xl gap-0 py-0 shadow-xl">
        <CardHeader className="gap-2 border-b border-border px-6 py-5">
          <span className="text-xs font-semibold uppercase tracking-[0.14em] text-primary">Configuração inicial · {step + 1} de 2</span>
          <h1 className="text-xl font-semibold tracking-tight text-foreground">{step === 0 ? "Prepare seu workspace" : "Crie o administrador local"}</h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {step === 0
              ? "O Threadmark armazena conversas, tickets e anexos no seu próprio computador."
              : "Esta conta controla usuários, integrações e as configurações sensíveis."}
          </p>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"><span className="block h-full rounded-full bg-primary transition-[width]" style={{ width: step === 0 ? "50%" : "100%" }} /></div>
        </CardHeader>
        <form className="grid" onSubmit={submit}>
          <CardContent className="space-y-4 px-6 py-5">
          {step === 0 ? (
            <>
              <label className="grid gap-1.5 text-xs font-medium text-foreground">
                Nome do workspace
                <Input autoFocus value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} />
              </label>
              <label className="grid gap-1.5 text-xs font-medium text-foreground">
                Fuso horário
                <Input value={timezone} onChange={(event) => setTimezone(event.target.value)} />
              </label>
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="flex gap-3 rounded-lg border border-border bg-muted/40 p-3"><Database className="shrink-0 text-primary" size={17} /><span><b className="block text-xs text-foreground">SQLite local</b><small className="mt-1 block text-xs leading-relaxed text-muted-foreground">O banco não é enviado para um servidor Threadmark.</small></span></div>
                <div className="flex gap-3 rounded-lg border border-border bg-muted/40 p-3"><ShieldCheck className="shrink-0 text-emerald-600" size={17} /><span><b className="block text-xs text-foreground">WhatsApp somente leitura</b><small className="mt-1 block text-xs leading-relaxed text-muted-foreground">O produto não possui envio de mensagens.</small></span></div>
              </div>
            </>
          ) : (
            <>
              {setup.legacyInstallation ? (
                <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800">
                  <CheckCircle2 size={17} /> Seu histórico existente será preservado integralmente.
                </div>
              ) : null}
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="grid gap-1.5 text-xs font-medium text-foreground">
                  Seu nome
                  <Input autoFocus autoComplete="name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
                </label>
                <label className="grid gap-1.5 text-xs font-medium text-foreground">
                  Login
                  <Input autoComplete="username" value={login} onChange={(event) => setLogin(event.target.value)} />
                </label>
                <label className="grid gap-1.5 text-xs font-medium text-foreground">
                  Senha
                  <Input autoComplete="new-password" minLength={12} type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
                </label>
                <label className="grid gap-1.5 text-xs font-medium text-foreground">
                  Confirmar senha
                  <Input autoComplete="new-password" minLength={12} type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
                </label>
              </div>
              {setup.bootstrapTokenRequired ? (
                <label className="grid gap-1.5 text-xs font-medium text-foreground">
                  Código de configuração exibido no terminal
                  <Input autoComplete="off" placeholder="Cole o código gerado pelo Threadmark" value={bootstrapToken} onChange={(event) => setBootstrapToken(event.target.value)} />
                </label>
              ) : null}
            </>
          )}
          {error ? <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">{error}</p> : null}
          </CardContent>
          <CardFooter className="m-0 justify-between rounded-none px-6 py-4">
            {step > 0 ? <Button type="button" variant="outline" onClick={() => setStep(0)}>Voltar</Button> : <span />}
            <Button disabled={submitting} type="submit" variant="default">
              {submitting ? <LoaderCircle className="animate-spin" size={16} /> : null}
              {step === 0 ? "Continuar" : "Concluir configuração"}
              {!submitting ? <ArrowRight size={16} /> : null}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </AccessFrame>
  );
}

function LoginScreen({ workspace, onLogin }: { workspace: string; onLogin(session: SessionState): void }) {
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      onLogin(await loginLocal({ login: login.trim(), password }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível entrar.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AccessFrame>
      <Card className="mx-auto w-full max-w-sm gap-0 py-0 shadow-xl">
        <CardHeader className="items-center gap-2 px-6 pb-3 pt-7 text-center">
          <span className="grid size-11 place-items-center rounded-xl bg-primary/10 text-primary"><KeyRound size={22} /></span>
          <span className="mt-2 text-xs font-semibold uppercase tracking-[0.14em] text-primary">{workspace}</span>
          <h1 className="text-xl font-semibold tracking-tight text-foreground">Bem-vindo de volta</h1>
          <p className="text-sm text-muted-foreground">Entre com a conta armazenada nesta instalação.</p>
        </CardHeader>
        <form className="grid gap-4 px-6 pb-7 pt-4" onSubmit={submit}>
          <label className="grid gap-1.5 text-xs font-medium text-foreground">Login<Input autoFocus autoComplete="username" value={login} onChange={(event) => setLogin(event.target.value)} /></label>
          <label className="grid gap-1.5 text-xs font-medium text-foreground">Senha<Input autoComplete="current-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          {error ? <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">{error}</p> : null}
          <Button className="w-full" disabled={submitting || !login.trim() || !password} type="submit" variant="default">
            {submitting ? <LoaderCircle className="animate-spin" size={16} /> : <LockKeyhole size={16} />}
            Entrar
          </Button>
        </form>
      </Card>
    </AccessFrame>
  );
}
