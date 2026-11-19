# Catálogo inicial

Na **primeira vez** que o portal sobe, com o catálogo ainda vazio, ele importa as APIs listadas em
`CATALOG_IMPORT` a partir dos documentos OpenAPI/Swagger delas. Essas APIs entram no lugar das APIs de
exemplo. A importação roda uma vez só: o resultado fica registrado e não se repete, mesmo que as APIs
sejam excluídas depois.

## Como configurar

No `.env` (ou nas variáveis do container):

```
CATALOG_IMPORT=catalogo-inicial/catalogo.json
```

`CATALOG_IMPORT` aceita:

- **links e/ou arquivos**, separados por vírgula ou quebra de linha:
  `CATALOG_IMPORT=https://api.exemplo.gov.br/openapi.json, catalogo-inicial/specs/protocolo.yaml`
- **um manifesto** (`.json`), como `catalogo.exemplo.json`, que diz de onde vem cada API e o que ajustar nela.

O link pode ser o do documento (`.json`/`.yaml`) ou o da página de documentação (Swagger UI, Redoc).
Nesse caso, o portal procura o documento do mesmo jeito que o botão *Importar OpenAPI → Link* do admin.

## O manifesto

Uma lista, ou `{ "apis": [...] }`. Cada item pode ser só o link ou arquivo, ou um objeto:

| Campo | O que faz |
|---|---|
| `source` | **Obrigatório.** Link ou arquivo (caminho relativo a esta pasta) do documento OpenAPI/Swagger |
| `name`, `slug`, `summary`, `version` | Trocam o que veio do documento |
| `category`, `owner`, `contactEmail`, `status` | Categoria, time responsável, contato e status (`estavel`, `beta`, `depreciada`, `em-desenvolvimento`) |
| `tags` | Somadas às tags do documento |
| `visibility`, `groups` | `"private"` e os grupos que podem ver a API (os grupos são criados depois, em *Pessoas*) |
| `baseUrl` | URL base, para documentos sem `servers` vindos de arquivo |
| `sync` | `false` desliga a sincronização do OpenAPI. Ligada por padrão para APIs vindas de link: o portal confere o documento todo dia e mostra o que mudou |

Ajustes que valem para todas as APIs importadas:

- Documento sem descrição: o resumo vira "Documentação da API &lt;nome&gt;".
- `servers` relativo (ex.: `/api/v3`): é resolvido a partir do endereço do documento.

## Conferir antes de subir

```bash
npm run import:check                                    # usa o CATALOG_IMPORT do .env
npm run import:check -- catalogo-inicial/catalogo.json  # ou o que for passado
```

O comando lê e converte cada fonte sem salvar nada, e diz o que seria importado e o que falharia.

## Quando algo falha

- **Uma fonte falha** (link fora do ar, arquivo inválido): as outras entram normalmente, e o erro de cada
  uma fica no log com `[importação inicial]`.
- **Todas falham** (por exemplo, sem rede): nada é registrado, e o portal tenta de novo na próxima vez
  que subir.
- **Para importar de novo:** com o catálogo vazio, apague o documento `setup` (`setup.json` na pasta de
  dados ou a linha `setup` da tabela `documents` no PostgreSQL).

No Docker Compose, esta pasta é montada em `/app/catalogo-inicial`, só para leitura. Coloque aqui o
`catalogo.json` e, se precisar, os documentos em `specs/`.
