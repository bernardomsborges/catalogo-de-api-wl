# Catálogo inicial

Na **primeira vez** que o portal sobe, com o catálogo ainda vazio, ele importa as APIs listadas em
`CATALOG_IMPORT` a partir dos documentos OpenAPI/Swagger delas. Essas APIs entram no lugar das APIs de
exemplo. A importação roda uma vez só: o resultado fica registrado e não se repete, mesmo que as APIs
sejam excluídas depois.

## O catálogo que vem pronto

O `catalogo.json` traz 14 APIs públicas, em quatro categorias:

| Categoria | APIs |
|---|---|
| Dados abertos do Brasil | BrasilAPI · IBGE · Portal da Transparência (CGU) |
| Utilitários para devs | JSONPlaceholder · REST Countries · HTTP Cat · HTTP Dog |
| Geolocalização, clima e espaço | Nominatim (OpenStreetMap) · Open-Meteo (previsão e histórico) · NASA (APOD, EPIC, asteroides) |
| Entretenimento e cultura | PokéAPI · OMDb · Open Library |

**De onde vem cada documento**
- **Documento oficial, por link:** BrasilAPI (achado na página de docs), Portal da Transparência,
  REST Countries, PokéAPI, OMDb e Open Library. A sincronização fica ligada e acompanha o que mudar.
- **Escrito para o catálogo, em `specs/`:** IBGE, JSONPlaceholder, HTTP Cat, HTTP Dog, Nominatim,
  Open-Meteo e NASA, que não publicam OpenAPI. Os documentos cobrem as rotas principais, conferidas na
  API real, e indicam a documentação oficial de cada uma.

**Exigem chave gratuita:** Portal da Transparência (`chave-api-dados`), NASA (`api_key`; `DEMO_KEY` serve
para testes), OMDb (`apikey`) e REST Countries, que passou a exigir conta (Bearer). O **Nominatim** não
pede chave, mas a política de uso exige um `User-Agent` que identifique a aplicação e no máximo 1
requisição por segundo.

**Ficaram de fora**
- As listas `public-apis/public-apis` e `public-api-lists/public-api-lists` são catálogos de APIs, não
  APIs. Servem de fonte para escolher as próximas.
- A API de fotos dos rovers de Marte da NASA foi desativada.

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
