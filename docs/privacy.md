# Privacidade e dados locais

Threadmark processa conteúdo de suporte que pode conter dados pessoais, informações comerciais e anexos confidenciais. Quem opera a instalação é responsável por ter base legal e autorização para capturar, armazenar e analisar esse conteúdo.

Este documento descreve o comportamento padrão do software; ele não substitui orientação jurídica nem uma política de privacidade da organização.

## O que é armazenado

Dependendo da configuração e das mensagens recebidas, a instalação pode guardar:

- número e nome da conta conectada;
- JIDs, números, LIDs e nomes de participantes;
- nomes e roster de grupos;
- texto, horário, autoria, respostas citadas e reações;
- imagens, PDFs, documentos, áudios e metadados de anexos;
- transcrições de áudio, confiança, estado da fila e falhas de processamento;
- tipos, campos, registros e segmentos do Diretório, tickets, categorias e status;
- prompts operacionais, resultados de IA, evidências e sugestões;
- usuários locais, sessões, configurações e trilha de auditoria;
- logs técnicos necessários para diagnóstico.

Áudio é preservado quando capturado, mas a transcrição local vem desativada por padrão. Quando ativada, o modelo roda na própria máquina e o texto resultante passa a integrar o contexto armazenado da conversa.

## Onde os dados ficam

O estado operacional fica em `SUPPORT_DATA_DIR`. O procedimento do README define `.data/`; sem essa variável, o runtime usa o diretório de dados da plataforma. O repositório ignora banco, WAL/SHM, anexos, autenticação do WhatsApp, logs, backups, exports, chaves e o cache de modelos em `models/transcription/`.

O download inicial do modelo de transcrição acessa o Hugging Face. O arquivo de áudio não é enviado nesse processo e a inferência ocorre localmente depois que o modelo foi instalado.

O projeto não oferece um backend hospedado central. Entretanto, ao configurar um provedor remoto de IA, o recorte enviado para análise deixa a máquina e passa a ser tratado também pelos termos e políticas daquele provedor. Use um provedor local quando essa transferência não for aceitável.

## Minimização

- Monitore apenas grupos necessários.
- Cadastre corretamente os integrantes da equipe para que não abram tickets.
- Restrinja conhecimento e raízes de código ao escopo indispensável.
- Não envie a um provedor de IA mais contexto do que o necessário.
- Evite registrar segredos em mensagens, notas ou prompts.
- Use o histórico privado apenas quando existir justificativa operacional.

## Retenção e exclusão

Excluir ou arquivar um registro do Diretório pode ser uma remoção operacional, preservando mensagens e auditoria. Arquivar um ticket também não apaga o conteúdo. Antes de atender uma solicitação de eliminação, confirme quais identidades, grupos, registros, mensagens, anexos, backups e logs precisam ser removidos e quais dados devem ser mantidos por obrigação legal.

Não apague diretamente arquivos do SQLite enquanto o serviço estiver ativo. Faça backup, pare o daemon e valide a integridade após qualquer manutenção de retenção.

## Backup e restauração

O backup integrado é a opção padrão. Ele cria um snapshot consistente do SQLite e das configurações não secretas e pode incluir anexos:

```bash
threadmark backup --full
threadmark backups list
```

Sessão do WhatsApp, chaves de IA, credenciais de ferramentas e o cache dos modelos de transcrição são excluídos deliberadamente. O texto já persistido no SQLite permanece no backup; o modelo pode ser baixado novamente depois da restauração. Guarde o diretório gerado em destino criptografado e teste a restauração conforme [UPGRADE.md](../UPGRADE.md).

Uma cópia manual de todo o `SUPPORT_DATA_DIR` é diferente: ela também contém auth state do WhatsApp, arquivo de chave e conteúdo cifrado do cofre, logs e outros dados operacionais. Use esse snapshot apenas para migração controlada ou recuperação completa:

1. Pare o Threadmark com `threadmark off`.
2. Confirme o caminho exato de `SUPPORT_DATA_DIR`.
3. Copie o diretório inteiro para um destino criptografado e com acesso restrito.
4. Defina prazo de retenção e descarte seguro.
5. Teste a restauração em ambiente controlado.

Backups podem conter dados já removidos da instalação ativa. A política de retenção deve incluí-los.

## Acesso local

- Use senha exclusiva para o administrador local.
- Não compartilhe a conta do sistema operacional que executa o serviço.
- Mantenha API e Web UI em loopback, salvo quando houver proxy autenticado e proteção de rede.
- Revogue sessões e credenciais quando alguém sair da equipe.
- Proteja o disco com criptografia do sistema operacional.

## Relatórios de bug

Nunca anexe `.data/`, QR Code, auth state, banco, dumps, tokens, prints de conversas reais ou logs brutos a uma issue pública. Crie uma reprodução com o ambiente de demonstração e remova identificadores antes de compartilhar qualquer evidência.
