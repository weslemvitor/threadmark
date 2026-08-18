# Diretório

O Diretório apresenta os grupos e as pessoas observados nas conversas sincronizadas do WhatsApp. Ele não impõe que um grupo seja um cliente nem cria uma camada adicional de classificação.

## Grupos

Cada grupo preserva seu identificador técnico e exibe, de forma amigável:

- nome do grupo;
- estado de monitoramento;
- quantidade de participantes ativos;
- quantidade de tickets vinculados e ainda abertos;
- última atividade conhecida.

## Pessoas

Pessoas são participantes observados em grupos sincronizados. A visão mostra nome, telefone, quantidade de grupos ativos, última atividade e se a identidade pertence à equipe.

Aliases de telefone (`@s.whatsapp.net`) e LID (`@lid`) são consolidados quando o vínculo é conhecido, evitando duplicidade. Quando não existe um nome confiável, a interface usa o telefone; identificadores protegidos permanecem apresentados sem expor o JID técnico como nome.

## Uso nos tickets

O grupo e o solicitante continuam vinculados ao ticket como contexto nativo. Organização adicional é feita por categorias, prioridade e responsável do atendimento. Nenhum vínculo do Diretório altera ou envia mensagens ao WhatsApp.

Para o modelo de dados e as rotas, consulte [architecture.md](architecture.md). Para retenção e eliminação, consulte [privacy.md](privacy.md).
