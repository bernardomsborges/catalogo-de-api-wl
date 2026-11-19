# Catálogo de APIs (whitelabel)

Portal para descobrir, entender e integrar as APIs de uma organização, inspirado no
[Conecta gov.br](https://www.gov.br/conecta/catalogo/). Esta é a versão **whitelabel**:
- **Sem identidade visual própria:** paleta neutra em cinza nos temas claro e escuro, e um símbolo genérico.
- **Identidade por variáveis de ambiente:** nome, organização, descrição e logo.
- **Catálogo inicial:** as APIs são importadas dos documentos OpenAPI na primeira subida.

## Whitelabel: a identidade do portal

Tudo o que nomeia o portal vem do ambiente (`server/src/branding.js`): títulos das páginas, cabeçalho,
rodapé, prévias de link, e-mails e os assistentes de IA.

| Variável | Padrão | O que faz |
|---|---|---|
| `PORTAL_NAME` | `Catálogo de APIs` | Nome do portal |
| `ORG_NAME` | — | Organização que publica as APIs. Aparece no rodapé ("Publicado por …"), na página do catálogo e para a IA |
| `PORTAL_DESCRIPTION` | "Encontre, entenda e integre as APIs de `ORG_NAME`." | Frase da página inicial, do rodapé e das prévias |
| `LOGO_URL` | — | Logo do cabeçalho e do rodapé, que ficam sobre fundo escuro: prefira a versão clara. Só `https://` ou um caminho do próprio portal. Sem ele, símbolo neutro + nome |

O servidor entrega esses valores no `index.html` (`<meta name="portal-brand">`), e o portal os lê ao
abrir, sem precisar de outra requisição.

**Cores:** a paleta neutra fica nos tokens de `web/src/styles.scss`. Para aplicar a cor de uma
organização, troque `--brand`, `--accent`, `--link` e `--grad-stops` no `:root` e no `dark-tokens`. As
cores de status e dos métodos HTTP são funcionais e não dependem da marca.

## Catálogo inicial

`CATALOG_IMPORT` lista os documentos OpenAPI/Swagger das APIs que entram no catálogo na **primeira vez**
que o servidor sobe, no lugar das APIs de exemplo. Aceita links (podem ser a página do Swagger UI ou do
Redoc), arquivos ou um manifesto `.json` que define a categoria, o time, a visibilidade e outros campos
de cada API.

```bash
CATALOG_IMPORT=catalogo-inicial/catalogo.json   # no .env
npm run import:check                            # confere as fontes sem salvar nada
```

- APIs vindas de link já saem com a sincronização do OpenAPI ligada.
- A importação roda uma vez só (fica registrada) e tenta de novo na próxima subida se todas as fontes falharem.

O projeto já traz um catálogo inicial em `catalogo-inicial/catalogo.json`, com 14 APIs públicas:
BrasilAPI, IBGE, Portal da Transparência, JSONPlaceholder, REST Countries, HTTP Cat e HTTP Dog,
Nominatim, Open-Meteo, NASA, PokéAPI, OMDb e Open Library. Detalhes, o formato do manifesto e as APIs
que exigem chave estão em [`catalogo-inicial/README.md`](catalogo-inicial/README.md). Há também um
exemplo menor, só com o Swagger Petstore: `catalogo-inicial/catalogo.exemplo.json`.

## O que tem

**Contas e permissões**
- Qualquer pessoa cria conta com e-mail e senha (`/cadastro`) e entra em `/entrar`. A sessão vale 7 dias e sobrevive a reinícios do servidor
- Papéis: **Administrador** (tudo, inclusive pessoas e acessos), **Editor** (documenta APIs e ReceAPItos, vê todas as APIs) e **Consumidor** (lê o portal)
- **APIs públicas ou privadas**: de uma API privada, todo mundo vê só o resumo (nome, resumo, categoria, status, versão e time). A documentação, as rotas, as credenciais, o console, o OpenAPI, a coleção do Postman, os ReceAPItos que a usam, o status e os avisos por e-mail ficam só para administradores, editores e membros dos **grupos** marcados na API. O bloqueio é no servidor, não só na tela
- **Pedido de acesso**: na página de uma API privada, a pessoa explica para que precisa e pede acesso; em *Minha conta* (`/conta`) ela também pode pedir para entrar num grupo e acompanha os pedidos. O administrador aprova em *Pessoas e acesso* (`/admin/pessoas`), escolhendo o grupo que libera a API
- **E-mails de acesso**: pedido novo vai para os administradores (e para o contato da API, para o time saber quem quer usar); a resposta, aprovada ou recusada com o motivo, vai para quem pediu
- **Esqueci minha senha** (`/esqueci-senha`): link por e-mail que vale 1 hora e só funciona uma vez; ao criar a senha nova, a pessoa entra e as outras sessões são encerradas. A resposta é a mesma para qualquer e-mail, para não revelar quem tem conta. Sem `SMTP_URL`, o link fica só no `OUTBOX_DIR`: em produção, configure o e-mail (ou o administrador define uma senha nova em *Pessoas*)
- **Assistente de IA com as permissões de quem pergunta**: o servidor só entrega à IA os dados que a pessoa pode ver. Das APIs privadas sem acesso, a IA recebe só o resumo: ela diz que a API existe, que a pessoa não tem acesso e como pedir, sem citar rotas. A IA recebe o papel e os grupos da pessoa, nunca o nome ou o e-mail

**Portal público**
- Página inicial com busca, categorias e APIs atualizadas recentemente
- Catálogo com busca e filtros por categoria, status e tipo de autenticação (filtros ficam na URL e podem ser compartilhados)
- Página de cada API com menu lateral:
  - **Visão geral**: descrição, URL base, ambientes, SLA, limites, time responsável
  - **Guias gerados automaticamente** a partir do cadastro: *Início rápido*, *Autenticação*, *Tratamento de erros* e *Checklist de produção*
  - **Guias personalizados** escritos pelo time (Markdown)
  - **Referência** no estilo Stripe: documentação do endpoint à esquerda e exemplos de código em **cURL, JavaScript, Python, Java, C#, Go e PHP** à direita
  - **Console de testes** com dois modos:
    - *Chamada real*: a requisição passa pelo servidor do catálogo (`POST /api/console/send`), então não esbarra no bloqueio de CORS do navegador. Por segurança, o servidor só chama a URL base ou os ambientes cadastrados daquela API, com limite de 60 chamadas/minuto, 15 s de tempo limite e 1 MB de resposta.
    - *Simulação*: responde com o exemplo documentado no endpoint, sem chamar a API (padrão para APIs com URL de exemplo, como `*.example`).
    - *Sessão*: quando o token Bearer é emitido pela própria API (ex.: `POST /v1/sessions`), o botão **Criar sessão** pede usuário e senha, chama essa rota e preenche o token sozinho. O token e as credenciais digitadas valem para todos os endpoints da API e ficam só na memória da aba; usuário e senha não são guardados. **Encerrar sessão** chama a rota de logout, quando existe.
  - **Novidades** (changelog)
  - Página **OpenAPI e coleção Postman** (no menu lateral, em Referência) com o download da especificação **OpenAPI 3** gerada
  - Na mesma página, a **coleção** para **Postman e Insomnia** (formato Postman v2.1): pastas por grupo de rotas (tag do OpenAPI ou, sem tag, o caminho), exemplos de corpo e de resposta, e um arquivo de ambiente para cada ambiente cadastrado. Cada credencial vira uma variável vazia (`{{X_API_Key}}`, `{{token}}`; o `-` vira `_` porque o Insomnia não aceita hífen em variável). Quando o token vem de uma rota da própria API (ex.: `POST /v1/sessions`), a coleção guarda o `access_token` na variável sozinha
  - **Acompanhar** (botão ao lado do título): a pessoa informa o e-mail, confirma pelo link e passa a receber avisos quando sai uma entrada nova em Novidades (mudanças que quebram integrações vêm em destaque) ou quando a API é depreciada. Cada aviso tem um link para deixar de acompanhar com um clique, e o cabeçalho `List-Unsubscribe` ativa o botão de cancelar do Gmail/Outlook
- **ReceAPItos** (`/receapitos`; os links antigos `/receitas/...` redirecionam): tarefas reais feitas com várias rotas, passo a passo (ex.: "abrir um processo e anexar um PDF"). Cada passo aponta para uma rota, com links para a referência e para o console, e mostra de que passo vem cada dado (`TOKEN ← passo 1`). O código completo em **cURL** (com `jq`), **Python** e **Go** é gerado a partir dos passos, e também as versões para colar no **Power Automate Desktop** (texto das ações) e **Cloud** (uma ação HTTP por passo, no formato de "Colar uma ação" do designer, mais as expressões para ler cada resposta). Se uma rota usada deixar de existir, a receita avisa. Busca e filtro por API
- **Status das APIs** (`/status`): o catálogo chama a rota de saúde de cada API a cada minuto e mostra *no ar*, *instável* (lenta, erro 4xx ou primeira falha) ou *fora do ar* (sem resposta ou 5xx duas vezes seguidas), o tempo de resposta e o histórico de 90 dias com a disponibilidade. Selo de status no card e na página de cada API. APIs sem rota de saúde aparecem como *sem monitoramento*. Quem acompanha a API recebe e-mail quando ela cai e quando volta
- **✨ Perguntar** (botão no topo, na busca da página inicial e em cada API): a pessoa descreve a tarefa e o assistente responde com a API e as rotas, em ordem, com as credenciais de cada passo, links para a referência e o console, e um exemplo de chamada. Ele só cita rotas que existem no catálogo (o servidor confere cada uma); chaves e tokens colados na pergunta são removidos antes de ir à IA. Sem resposta, diz isso e indica o contato do time. Sem IA configurada, mostra as rotas mais parecidas pela busca por palavras
- Tema claro/escuro automático e layout para celular

**Painel admin** (`/admin`, para administradores e editores)
- **Pessoas e acesso** (só administradores): pedidos de acesso, pessoas (papel, grupos, senha, desativar) e grupos
- Lista com indicadores, filtro, editar e excluir (com confirmação). A coluna **Nota** mostra a qualidade da documentação de cada API e ordena pelas piores
- Formulário completo: dados básicos, ambientes, autenticação, endpoints (parâmetros, corpo, respostas), guias e novidades
- **Grupo** de cada rota (vem da tag do OpenAPI na importação e na sincronização): vira pasta na coleção do Postman/Insomnia
- **Importação de OpenAPI 3 / Swagger 2** (JSON ou YAML) por **link** (o link pode ser a própria página da documentação, como Swagger UI, Redoc ou um site em Next.js: o servidor procura a especificação dentro da página, nos endereços que ela cita e nos endereços comuns, como `/openapi.json` e `/v3/api-docs`; a credencial de leitura só vai para o mesmo site do link; com a mesma autenticação da sincronização e a opção de já deixar a API sincronizada), arquivo ou texto colado. Preenche o formulário, incluindo **todas** as credenciais (`securitySchemes`): vários cabeçalhos de identificação, Bearer, Basic, OAuth 2.0, chaves em query/cookie, se vão juntas ou são alternativas, e endpoints públicos ou com regra própria
- **Sincronização do OpenAPI**: cadastre a URL da especificação e, se ela for protegida, como ler: token Bearer, Basic (usuário e senha), cabeçalho personalizado, parâmetro na URL ou OAuth 2.0 *client credentials*. A parte secreta fica só no servidor. O catálogo busca o documento 1 vez por dia ou no botão *Sincronizar agora* e mostra as rotas novas, removidas e alteradas. *Aplicar mudanças* atualiza rotas, parâmetros, respostas e credenciais, e mantém guias, categoria, status, ambientes e textos editados à mão
- **Mudanças que quebram integrações**: na sincronização e na reimportação, as mudanças aparecem separadas em *Quebra integrações* (rota removida, parâmetro ou campo do corpo que passou a ser obrigatório, campo da resposta removido ou com outro tipo, credencial nova ou trocada) e *Compatível*. O catálogo sugere a nova versão (maior quando quebra, menor quando é compatível) e uma entrada de Novidades editável, e pede confirmação antes de publicar uma versão que quebra
- **Várias credenciais por API**: cada uma com nome, local (cabeçalho, query ou cookie) e descrição; marque quais valem por padrão e ajuste por endpoint
- **Nota de qualidade da documentação** (0 a 100): soma descrição e resumo em português, contato do time, título e descrição das rotas, parâmetros com descrição e exemplo, respostas de sucesso com exemplo, erros documentados, credenciais com instruções e pelo menos um guia ou ReceAPIto. Muda na hora enquanto você edita e lista o que falta, com link direto para cada campo. A partir de 90 o portal mostra o selo **Documentação completa** na página da API. As regras ficam em `shared/doc-quality.ts`, usadas também pelo *Melhorar com IA*
- **Prévia** dos guias antes de salvar
- **✨ Melhorar com IA** (na API inteira ou em cada rota): mira na nota 100 da qualidade: traduz títulos em inglês vindos do FastAPI, escreve as descrições que faltam (API, rotas, parâmetros, respostas e credenciais) e o "como obter as credenciais", sugere exemplos de parâmetros e de respostas (com aviso para conferir com uma resposta real) e propõe as respostas de sucesso e de erro que não estão documentadas (400, 401, 404, 500, conforme a rota). Mostra a nota agora e a nota se aceitar tudo, lista o que só uma pessoa pode preencher (time e e-mail de contato) e escreve rascunhos de guias. Cada sugestão pode ser aceita, editada ou recusada, e nada vai ao portal antes de salvar/publicar. Sugestões que citam rotas, parâmetros ou campos que não existem são descartadas pelo servidor
- **✨ Montar com IA** (no formulário de ReceAPIto): a pessoa descreve a ideia das requisições ("consultar um CEP e depois a previsão do tempo da cidade") e o assistente escolhe as rotas no catálogo, ordena os passos, liga as variáveis entre eles e preenche o formulário. Mensagens seguintes ajustam o rascunho ("guarde também a UF"), e dá para desfazer cada alteração. A IA só pode usar rotas que existem no catálogo; parâmetros ou campos que não batem com a rota voltam como avisos. Nada é salvo até a pessoa salvar o ReceAPIto.
- **Rascunho e publicação**: *Salvar rascunho* guarda as mudanças sem mexer no portal; *Publicar* as coloca no ar. Se outra pessoa publicou enquanto você editava, a publicação é recusada com aviso, sem sobrescrever
- **Exportar e importar APIs** (para levar de homologação para produção): *Exportar* no painel gera um arquivo `.json` (ou copia o conteúdo) com as APIs escolhidas e os ReceAPItos que usam só elas. Em *Importar* (`/admin/importar`), no outro catálogo, envie o arquivo ou cole o conteúdo e veja antes o que vai mudar: cada item aparece como nova, atualizada, sem mudanças ou com erro, e você escolhe o que entra. As APIs são reconhecidas pelo identificador (slug), as privadas levam os grupos pelo nome, e os grupos que faltam podem ser criados na hora (só administradores). Cada atualização vira uma versão nova no histórico, com a nota "Importada". Rascunhos, histórico, quem acompanha, monitoramento e sincronização do OpenAPI não vão no arquivo
- **Histórico de versões**: cada publicação vira uma versão (data, autor e nota). *Ver* mostra o que muda em relação à versão atual e *Restaurar* publica de novo uma versão antiga, sem apagar as outras
- **Monitoramento**: em cada API, o ambiente, a rota de saúde e a credencial da verificação (Bearer, Basic, cabeçalho, parâmetro na URL ou OAuth 2.0; a parte secreta fica só no servidor)
- **ReceAPItos** (`/admin/receapitos`): criar e editar ReceAPItos escolhendo a API e a rota de cada passo (credenciais, parâmetros e corpo vêm preenchidos), guardar dados da resposta em variáveis e ver o código gerado

## Estrutura

```
web/      Front-end Angular 22 (standalone, signals, zoneless)
server/   Back-end Node + Express; dados em server/data/apis.json
shared/   Regras usadas pelos dois lados (nota da documentação), em TypeScript que o Node roda direto
catalogo-inicial/   Manifesto e documentos OpenAPI do catálogo inicial (CATALOG_IMPORT)
server/generated/   Conversor de OpenAPI do portal, empacotado para o servidor por `npm run build`
```

Na primeira execução, `server/data/apis.json` é criado a partir de `server/data/seed.json` (4 APIs de exemplo). Com `CATALOG_IMPORT`, o catálogo começa vazio e recebe as APIs da importação inicial.

Para usar **PostgreSQL**, defina `DATABASE_URL`. As tabelas são criadas sozinhas e, com o banco vazio, as APIs do `apis.json` atual são importadas (credenciais, regras por endpoint e tudo mais). Todo o resto também vai para o banco (tabela `documents`): contas (pessoas, grupos e pedidos de acesso), ReceAPItos, inscrições, sincronização do OpenAPI, monitoramento, perguntas sem resposta da IA e o cache da busca. Na primeira subida, cada arquivo `.json` existente é importado, então nada se perde na troca. Com o banco, o volume `/data` só guarda os e-mails de teste (`outbox`).

Sem banco, os dados ficam em arquivos JSON. Se um arquivo existir e não puder ser lido, o servidor não sobe, em vez de começar vazio e gravar por cima. O `docker-compose.yml` já sobe um PostgreSQL (defina `DB_PASSWORD`).

## Como rodar

```bash
npm run install:all

# desenvolvimento (dois terminais)
npm run dev:server     # API em http://localhost:3000
npm run dev:web        # portal em http://localhost:4200 (redireciona /api para o servidor)

# produção (servidor entrega o portal e a API na mesma porta)
npm start              # http://localhost:3000
```

### Testes

```bash
npm test               # servidor e portal (ou: npm --prefix server test / npm --prefix web test)
```

Usam o `node:test` do próprio Node, sem dependência nova. Cobrem as partes mais fáceis de quebrar sem perceber:

- **Permissões das APIs privadas** (`server/test`): as regras de quem vê o quê e, com o servidor de verdade rodando numa pasta temporária, as rotas `/api/apis`, `/api/console/send`, `/api/recipes` e `/api/ai/ask` para quem não tem acesso
- **Portal** (`web/test`): mudanças que quebram integrações, nota de qualidade da documentação, importação e exportação de OpenAPI/Swagger, coleção do Postman/Insomnia e o código gerado dos ReceAPItos (cURL, Python, Go e Power Automate). Quando `bash`, `python` ou `gofmt` estão instalados, o código gerado também passa pela verificação de sintaxe deles; sem eles, essa parte é pulada

Os arquivos `.ts` do portal rodam no Node com o compilador TypeScript que já vem no `web/` (`web/test/ts-hooks.mjs`).

### Verificações do CI

Cada PR para `main` roda o workflow `.github/workflows/ci.yml`: build do portal, verificação de tipos do servidor, testes e build da imagem Docker, que também precisa subir e responder em `/healthz`. Se algo falhar, o PR aparece como reprovado no GitHub. Para rodar as mesmas verificações na sua máquina (Node 24):

```bash
npm ci --prefix server && npm ci --prefix web
npm run build
npm --prefix server run typecheck          # verificação de tipos do servidor (server/tsconfig.json)
npm test                                   # instale Go para incluir a verificação do código Go gerado
docker build -t catalogo-apis:ci .
docker run --rm -p 3000:3000 -e ADMIN_PASSWORD=qualquer-senha catalogo-apis:ci   # e abra http://localhost:3000
```

### Configuração do servidor

No desenvolvimento, as variáveis podem ficar num arquivo `.env` na raiz (já ignorado pelo Git); `npm start` e `npm run dev:server` o carregam. Copie o `.env.example` para começar: nele ficam a URL e a chave do LiteLLM e os modelos (`LLM_MODEL` para conversa e `LLM_EMBEDDING_MODEL` para a busca por significado).

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3000` | Porta HTTP |
| `TRUST_PROXY` | — | Use quando o portal fica atrás de um proxy (nginx, load balancer): sem ele, o servidor vê o IP do proxy e todo mundo divide os mesmos limites de chamadas (login, assistente, console, inscrições). Aceita o número de proxies na frente (`1` para um nginx), endereços dos proxies (`loopback`, `10.0.0.0/8, 172.16.0.0/12`) ou `true`. Evite `true` se as pessoas puderem chegar ao servidor sem passar pelo proxy: aí qualquer um forja o IP pelo cabeçalho `X-Forwarded-For` |
| `ADMIN_EMAIL` | `admin` | E-mail do primeiro administrador, criado quando ainda não existe nenhum (`ADMIN_USER` ainda é aceito) |
| `ADMIN_PASSWORD` | `troque-esta-senha` | Senha desse primeiro administrador — **troque antes de publicar** (ou depois, em *Minha conta*) |
| `OIDC_ISSUER` | — | Login com o SSO da organização (OpenID Connect), ex.: `https://login.exemplo.gov.br/realms/estado`. Sem ele, só e-mail e senha. Veja *Login com SSO* abaixo |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | — | Cliente cadastrado no provedor. Sem o segredo, o catálogo entra como cliente público (só PKCE) |
| `OIDC_TOKEN_AUTH` | `basic` | Como o segredo vai para o provedor: `basic` (`client_secret_basic`) ou `post` (`client_secret_post`) |
| `OIDC_SCOPES` | `openid email profile` | Escopos pedidos ao provedor |
| `OIDC_LABEL` | `Entrar com a conta da organização` | Texto do botão na tela de login |
| `OIDC_ALLOWED_DOMAINS` | — | Só entram e-mails destes domínios, separados por vírgula (ex.: `mg.gov.br`). Vazio: qualquer um que o provedor aceitar |
| `PASSWORD_LOGIN` | `true` | `false` deixa só o SSO: some o login com e-mail e senha, o cadastro e o "Esqueci minha senha". Só vale com o SSO configurado |
| `SESSION_SECRET` | gerada e guardada em `accounts.json` | Chave que assina as sessões. Trocá-la desconecta todo mundo |
| `SESSION_DAYS` | `7` | Quantos dias a pessoa fica conectada |
| `ACCESS_REQUESTS_EMAIL` | `CATALOG_CONTACT_EMAIL` | Para onde vão os pedidos de acesso quando nenhum administrador tem e-mail (ex.: o primeiro, `admin`). Melhor: troque o e-mail dele em *Pessoas* |
| `RESET_MINUTES` | `60` | Validade do link de "Esqueci minha senha" |
| `ACCOUNTS_FILE` | `accounts.json` na pasta do `DATA_FILE` | Pessoas (senhas com scrypt), grupos e pedidos de acesso. Com `DATABASE_URL`, só é lido uma vez, para importar (vale para todos os `*_FILE` abaixo) |
| `DATABASE_URL` | — | PostgreSQL, ex.: `postgres://usuario:senha@host:5432/catalogo`. Com ele, todos os dados ficam no banco; no primeiro uso com o banco vazio, o `DATA_FILE` (ou o seed) é importado. Sem ele, tudo fica em arquivos JSON |
| `DATA_FILE` | `server/data/apis.json` | Arquivo das APIs (modo sem banco) e origem da importação |
| `HEALTH_INTERVAL_SECONDS` | `60` | Intervalo das verificações de saúde |
| `HEALTH_TIMEOUT_MS` | `10000` | Tempo sem resposta para contar como falha |
| `HEALTH_SLOW_MS` | `3000` | Acima disso, a API aparece como instável |
| `HEALTH_FILE` | `health.json` na pasta do `DATA_FILE` | Configuração e histórico das verificações |
| `LLM_BASE_URL` | — | Provedor de IA compatível com OpenAI (LiteLLM), ex.: `https://litellm.exemplo.gov.br/v1`. Sem ele, os recursos de IA ficam desligados |
| `LLM_API_KEY` | — | Chave do LiteLLM (fica só no servidor) |
| `LLM_MODEL` | `gpt-4o-mini` | Modelo de conversa |
| `LLM_EMBEDDING_MODEL` | `text-embedding-3-small` | Modelo de embeddings (busca por significado) |
| `CATALOG_CONTACT_NAME` / `CATALOG_CONTACT_EMAIL` | `Time do Catálogo de APIs` / — | Contato indicado quando o assistente não encontra resposta |
| `RECIPES_FILE` | `recipes.json` na pasta do `DATA_FILE` | ReceAPItos |
| `SYNC_FILE` | `spec-sync.json` na pasta do `DATA_FILE` | Configuração da sincronização do OpenAPI (inclui as credenciais de leitura) |
| `SYNC_INTERVAL_HOURS` | `24` | De quantas em quantas horas o catálogo busca cada especificação |
| `PUBLIC_URL` | `http://localhost:PORT` | Endereço público do portal. Usado nos links dos e-mails, no CORS (só esta origem pode chamar a API pelo navegador) e no HSTS, que só é enviado quando o endereço é `https://` |
| `CORS_ORIGINS` | — | Outras origens que podem chamar a API pelo navegador, separadas por vírgula. Fora de produção (`NODE_ENV` diferente de `production`), `http://localhost:4200` já entra |
| `SMTP_URL` | — | Servidor de e-mail, ex.: `smtp://usuario:senha@smtp.exemplo.gov.br:587`. Sem ele, os e-mails são gravados em `OUTBOX_DIR` |
| `MAIL_FROM` | `Catálogo de APIs <nao-responda@localhost>` | Remetente dos e-mails |
| `OUTBOX_DIR` | `outbox` na pasta do `DATA_FILE` | Onde os e-mails ficam quando não há `SMTP_URL` |
| `SUBSCRIPTIONS_FILE` | `subscriptions.json` na pasta do `DATA_FILE` | Quem acompanha cada API |
| `METRICS_FILE` | `metrics.json` na pasta do `DATA_FILE` | Métricas de uso: contadores anônimos por dia, guardados por 120 dias (com `DATABASE_URL`, ficam no PostgreSQL) |
| `LOG_FORMAT` | `json` com `NODE_ENV=production` (a imagem Docker), `text` nos outros casos | Formato dos logs: uma linha JSON por evento (horário, nível, mensagem e `reqId`, o id da requisição) ou linhas legíveis para desenvolvimento |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` ou `error`. Em `debug`, aparecem também as chamadas do healthcheck |

### PostgreSQL e MailHog no desenvolvimento

O `docker-compose.dev.yml` complementa o `docker-compose.yml`: abre o PostgreSQL na porta 5434 e sobe o MailHog, que recebe os e-mails do servidor e mostra todos numa caixa em http://localhost:8025, com os links clicáveis. As portas ficam abertas só para esta máquina.

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d db mailhog
```

No `.env`, com o `DB_PASSWORD` definido:

```
DATABASE_URL=postgres://catalogo:<DB_PASSWORD>@127.0.0.1:5434/catalogo
SMTP_URL=smtp://127.0.0.1:1025
```

Depois rode `npm run dev:server`. Para subir tudo no Docker, tire o `db mailhog` do fim do comando e use `SMTP_URL=smtp://mailhog:1025`. O arquivo é separado para não ir para produção por engano.

## Rodando com Docker

A imagem compila o portal durante o build e roda só o servidor Node, sem usuário root.

```bash
docker build -t catalogo-apis .
docker run -d -p 3000:3000 \
  -e ADMIN_PASSWORD=troque-esta-senha \
  -v catalogo-data:/data \
  catalogo-apis
```

O portal fica em http://localhost:3000. As APIs cadastradas são salvas no volume `catalogo-data`
(`/data/apis.json` dentro do container), então continuam lá quando o container é recriado. Na
primeira execução o arquivo é criado com as APIs de exemplo.

Com Docker Compose, defina `ADMIN_PASSWORD` num arquivo `.env` na raiz (ou no ambiente) e rode:

```bash
docker compose up -d --build
```

A senha do admin vem só da variável de ambiente; nada de credencial vai dentro da imagem. As sessões
são tokens assinados, então reiniciar o container não desloga ninguém.

### Login com SSO

O catálogo aceita qualquer provedor OpenID Connect (Entra ID, Keycloak, gov.br…), pelo fluxo de
código de autorização com PKCE (`server/src/sso.js`):

1. Cadastre o catálogo no provedor com o endereço de retorno `<PUBLIC_URL>/api/auth/sso/callback`.
2. Defina `OIDC_ISSUER`, `OIDC_CLIENT_ID` e `OIDC_CLIENT_SECRET` (e, se quiser, `OIDC_LABEL` e `OIDC_ALLOWED_DOMAINS`).
3. A tela de login passa a mostrar o botão do SSO.

Quem entra pelo SSO é reconhecido pela identidade no provedor ou, no primeiro login, pelo e-mail.
Assim, uma conta que já existia (como a do primeiro administrador, se `ADMIN_EMAIL` for o seu e-mail da
organização) continua com o mesmo papel e os mesmos grupos. Quem ainda não tinha conta entra como
consumidor, e um administrador muda o papel em *Pessoas*. O SSO só diz quem a pessoa é: o que ela pode
fazer no catálogo continua sendo decidido aqui.

Para deixar só o SSO, use `PASSWORD_LOGIN=false`. Nesse modo, o administrador cadastra pessoas sem
senha: elas entram pelo SSO com o e-mail cadastrado e já recebem o papel escolhido.

Cada alteração em uma API fica no histórico de versões com autor e data (*Histórico* no painel).
Uma exclusão leva o histórico junto, então ela fica registrada no log do servidor (`[auditoria]`).

### Uma réplica só

O catálogo roda com **uma cópia só** do servidor. Ele carrega os dados na memória ao subir e grava o
documento inteiro a cada mudança, guarda os limites de chamadas na memória e roda sozinho as
verificações de saúde e a sincronização do OpenAPI. Com duas cópias, uma sobrescreveria as mudanças
da outra, os limites deixariam de valer e cada e-mail sairia em dobro.

Com PostgreSQL, isso é garantido: ao subir, o servidor pega uma trava no banco (`pg_advisory_lock`) e
a segura enquanto roda. Uma segunda cópia fica esperando, sem abrir a porta, até a primeira parar, e
então assume. Isso também deixa uma troca de versão sem tempo fora do ar mais segura. Se a conexão que
segura a trava cair, o servidor para, para nunca rodar junto com outra cópia. Sem banco, rode uma cópia
por pasta de dados (volume).

### Estrutura do banco (migrações)

As tabelas do PostgreSQL são criadas e alteradas por arquivos numerados em
`server/src/db/migrations/` (`001-tabelas-iniciais.sql`, `002-…`). Ao subir, depois da trava de
instância e antes de carregar qualquer dado, o servidor aplica em ordem os que ainda não rodaram, cada
um numa transação junto com a sua linha na tabela `schema_migrations`. Se um falhar, o banco fica como
estava e o servidor não sobe. Bancos criados antes das migrações adotam a versão 1 sem mudança nenhuma.

Para mudar a estrutura, crie o próximo arquivo (ex.: `002-indice-por-slug.sql`). Nunca edite um arquivo
que já rodou em algum ambiente: escreva outro que corrija.

### Backup e restauração

O `docker-compose.yml` sobe o serviço `backup`, que roda o `pg_dump` ao subir e depois a cada
`BACKUP_EVERY_HOURS` horas (padrão: 24) e guarda os arquivos no volume `catalogo-backups`. Os backups
com mais de `BACKUP_KEEP_DAYS` dias (padrão: 14) são apagados. O backup leva tudo: APIs, histórico,
rascunhos, contas, ReceAPItos e a versão do schema.

O volume fica no mesmo servidor do banco, então copie os backups para outro lugar com frequência:

```bash
docker compose logs backup                         # um "[backup] /backups/catalogo-….dump" por backup
docker compose cp backup:/backups ./backups        # copia todos para a pasta ./backups
```

Backup na hora, antes de uma mudança arriscada:

```bash
docker compose exec backup sh -c 'pg_dump --format=custom --file=/backups/catalogo-$(date +%Y%m%d-%H%M%S).dump'
```

Para restaurar, pare o catálogo antes, para ele não gravar por cima nem reimportar as APIs de exemplo
num banco vazio:

```bash
docker compose stop catalogo
docker compose exec backup pg_restore --clean --if-exists --no-owner --dbname=catalogo /backups/catalogo-AAAAMMDD-HHMMSS.dump
docker compose start catalogo
```

Um arquivo de fora do volume entra com `docker compose cp ./arquivo.dump backup:/backups/`. No Git
Bash do Windows, rode `export MSYS_NO_PATHCONV=1` antes, senão o caminho `/backups/…` é trocado por um
caminho do Windows.

### Cabeçalhos de segurança

Toda resposta sai com `Content-Security-Policy`, `X-Content-Type-Options`, `X-Frame-Options`
(o portal não abre dentro de outra página), `Referrer-Policy`, `Cross-Origin-Opener-Policy` e
`Permissions-Policy`. Com `PUBLIC_URL` em `https://`, também `Strict-Transport-Security`. A CSP só
aceita scripts do próprio portal: os scripts escritos dentro do `index.html` entram pelo hash, que o
servidor calcula do arquivo compilado ao subir (`server/src/security.js`), então mudar esses scripts
não exige mexer na política. As fontes vêm do Google Fonts, e as imagens dos guias podem vir de qualquer
endereço `https://`.

## Próximos passos sugeridos

- Fluxo de aprovação antes de publicar uma versão de API
- Escolher o provedor de SSO da organização e configurá-lo (o catálogo já aceita OpenID Connect)
