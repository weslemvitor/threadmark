"use client";

import { Copy } from "lucide-react";
import { type ReactNode, useSyncExternalStore } from "react";

import { Button } from "@/app/components/ui/button";

const INSTALL_COMMAND = [
  "git clone https://github.com/weslemvitor/threadmark.git",
  "cd threadmark",
  "npm install",
  "npm run package:build",
  "npm link",
  "threadmark --version",
].join("\n");

const subscribeToOrigin = () => () => {};
const getOrigin = () => window.location.origin;
const getServerOrigin = () => "";

export function CliSetupGuide({
  onFeedback,
}: {
  onFeedback(tone: "success" | "error", message: string): void;
}) {
  const origin = useSyncExternalStore(subscribeToOrigin, getOrigin, getServerOrigin);
  const connectionCommand = origin
    ? `threadmark remote add production --url '${origin.replaceAll("'", "'\\''")}'`
    : "";
  const testCommand = [
    "threadmark remote status production --json",
    "threadmark --remote production capabilities --json",
    "threadmark --remote production tickets list --json",
  ].join("\n");
  const agentPrompt = [
    "Use a CLI Threadmark instalada neste computador para acessar o remoto production.",
    "Use sempre o prefixo threadmark --remote production e a saída --json.",
    "Consulte as capacidades disponíveis e liste os tickets que precisam de atenção.",
    "Faça somente consultas nesta etapa; peça minha autorização antes de alterar dados.",
    "Se a conexão falhar, informe o erro e não use uma instância local como alternativa.",
  ].join("\n");

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      onFeedback("success", "Instrução copiada.");
    } catch {
      onFeedback("error", "Não foi possível copiar automaticamente. Selecione e copie o texto.");
    }
  }

  function command(label: string, value: string) {
    return (
      <div className="mt-3 min-w-0 overflow-hidden rounded-xl border border-border bg-muted/40">
        <div className="flex items-center justify-between gap-3 border-b border-border/70 px-3 py-2">
          <span className="text-xs text-muted-foreground">{label}</span>
          <Button
            aria-label={`Copiar ${label.toLocaleLowerCase("pt-BR")}`}
            disabled={!value}
            onClick={() => void copy(value)}
            size="sm"
            type="button"
            variant="ghost"
          >
            <Copy size={14} /> Copiar
          </Button>
        </div>
        <pre className="overflow-x-auto p-3 text-xs leading-6 text-foreground"><code>{value || "Carregando endereço da instalação…"}</code></pre>
      </div>
    );
  }

  return (
    <div className="min-w-0">
      <p className="mb-5 text-sm leading-6 text-muted-foreground">
        Configure a CLI no mesmo computador em que você usa o Codex ou outro agente.
        Ela se conecta a esta instalação por HTTPS. Nesta versão, o login HTTPS está disponível no macOS.
      </p>
      <ol className="space-y-6">
        <SetupStep number={1} title="Instale a CLI no seu computador">
          <p>Se a CLI já estiver instalada, confirme com <code>threadmark --version</code> e siga para a próxima etapa.</p>
          <details className="mt-3 rounded-xl border border-border p-3">
            <summary className="cursor-pointer text-sm font-medium text-foreground">Ver comandos de instalação</summary>
            <p className="mt-3">Com Git e Node.js 22.13 ou superior instalados, execute no terminal do seu computador:</p>
            {command("Instalação", INSTALL_COMMAND)}
          </details>
        </SetupStep>
        <SetupStep number={2} title="Conecte a CLI a esta instalação">
          <p>Execute no terminal do seu computador. O endereço abaixo é o desta instalação. Se o remoto production já estiver cadastrado com esse endereço, siga para o login.</p>
          {command("Cadastro da instalação", connectionCommand)}
          {command("Login", "threadmark remote login production")}
          <p className="mt-3">Cole o mesmo token nas duas solicitações do Chaves do macOS (Keychain). Ele fica salvo no seu computador. Não cole o token no chat do agente.</p>
        </SetupStep>
        <SetupStep number={3} title="Confira a conexão">
          {command("Teste da conexão", testCommand)}
          <p className="mt-3">O status deve mostrar sua credencial e seu usuário. Os próximos comandos retornam as capacidades e a lista de tickets; uma lista vazia também é uma resposta válida.</p>
          <p className="mt-2">Se houver erro de conexão ou autenticação, confira o endereço HTTPS e a validade da credencial.</p>
        </SetupStep>
        <SetupStep number={4} title="Use com o Codex ou outro agente">
          <p>Abra um chat local no mesmo computador, com acesso ao terminal, e envie esta instrução:</p>
          {command("Instrução para o agente", agentPrompt)}
          <p className="mt-3">Se o agente não encontrar o comando threadmark, informe a ele o caminho retornado por <code>command -v threadmark</code> no seu terminal.</p>
        </SetupStep>
      </ol>
    </div>
  );
}

function SetupStep({ number, title, children }: { number: number; title: string; children: ReactNode }) {
  return (
    <li className="min-w-0 rounded-2xl border border-border bg-card p-4 sm:p-5">
      <h3 className="mb-3 flex items-center gap-3 font-semibold text-foreground">
        <span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-full bg-primary/10 text-xs text-primary">{number}</span>
        {title}
      </h3>
      <div className="min-w-0 text-sm leading-6 text-muted-foreground">{children}</div>
    </li>
  );
}
