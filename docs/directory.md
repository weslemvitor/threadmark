# Diretório personalizável

O Diretório organiza o contexto das conversas sem impor que todo grupo seja um cliente ou que toda instalação use a mesma taxonomia. Ele combina identidades sincronizadas do WhatsApp com registros operacionais criados localmente.

## Conceitos

### Grupos e pessoas

Grupos e pessoas são entidades nativas capturadas do WhatsApp. Seus identificadores, participantes e vínculos sustentam autoria, timeline e elegibilidade de triagem. Eles não precisam virar registros personalizados para continuarem disponíveis como contexto.

### Tipos de registro

Um tipo define a categoria de uma entidade criada pela instalação. Exemplos genéricos incluem `Organização`, `Projeto`, `Produto`, `Contrato` e `Unidade`. O nome, plural, descrição e cor podem ser definidos pela interface.

### Campos personalizados

Cada tipo possui seu próprio conjunto de campos:

| Tipo | Uso típico |
| --- | --- |
| Texto | código interno, observação curta ou responsável |
| Número | limite, quantidade ou valor de referência |
| Booleano | condição ativa/inativa |
| Data | renovação, implantação ou vencimento |
| URL | painel, documentação ou sistema externo |
| Seleção | uma opção controlada |
| Múltipla seleção | etiquetas controladas |
| Relação | referência a outro tipo de registro |

Campos podem ser obrigatórios, ordenados e editados. Alterar um campo não modifica mensagens do WhatsApp.

### Registros e relações

Um registro é uma instância de um tipo. Ele pode conter valores personalizados e se vincular a:

- um ou mais grupos;
- uma ou mais pessoas;
- outros registros.

Esses vínculos permitem compartilhar contexto. Um `Projeto`, por exemplo, pode se relacionar com uma `Organização`, dois grupos e as pessoas responsáveis. Arquivar um registro o remove das visões ativas sem apagar conversas ou tickets.

### Segmentos

Um segmento salva filtros sobre campos de um tipo. Os filtros podem exigir que todas as regras sejam verdadeiras ou aceitar qualquer uma delas. Operadores disponíveis incluem igualdade, diferença, conteúdo, vazio, comparação numérica e comparação de data conforme o tipo do campo.

## Exemplo de configuração

1. Abra **Diretório** e confirme que os grupos e pessoas esperados foram sincronizados.
2. Crie o tipo `Organização`.
3. Adicione os campos `Plano` como seleção, `Região` como seleção e `Renovação` como data.
4. Crie um registro para uma organização fictícia e associe seus grupos e pessoas.
5. Crie o segmento `Renova neste ciclo` usando o campo de data e os critérios adequados à operação.
6. Use os registros vinculados para analisar tickets e indicadores sem alterar o histórico original.

Outra instalação pode criar tipos e campos completamente diferentes. O Threadmark não exige uma estrutura comercial específica.

## Permissões e persistência

Tipos e campos exigem papel de owner ou admin. Registros e segmentos ficam no mesmo SQLite operacional e participam da auditoria local. A rota `DELETE /api/directory/records/:id` arquiva o registro; não exclui mensagens, anexos ou autoria.

Para o modelo de dados e as rotas, consulte [architecture.md](architecture.md). Para retenção e eliminação, consulte [privacy.md](privacy.md).
