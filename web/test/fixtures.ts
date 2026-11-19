import type { Api } from '../src/app/core/models';
import { importOpenApi } from '../src/app/core/openapi';

/**
 * A small API like the real ones: a client id header on every route, a bearer token issued by the
 * API itself (POST /v1/sessoes, ended by DELETE /v1/sessoes/atual), one public route and routes
 * grouped by tag.
 */
export const SPEC = `
openapi: 3.0.3
info:
  title: API de Processos
  version: 2.3.1
  description: Abre e consulta processos.
  contact: { name: Time de Processos, email: processos@exemplo.gov.br }
servers:
  - { url: https://api.exemplo.gov.br, description: Produção }
  - { url: https://hml.exemplo.gov.br, description: Homologação }
tags:
  - name: Sessões
  - name: Processos
components:
  securitySchemes:
    ClientId: { type: apiKey, in: header, name: X-Client-Id, description: Identificador do sistema. }
    Sessao: { type: http, scheme: bearer, bearerFormat: JWT }
  schemas:
    Processo:
      type: object
      required: [id, numero]
      properties:
        id: { type: integer, example: 42 }
        numero: { type: string, example: "0001.2026" }
        assunto: { type: string }
security:
  - ClientId: []
    Sessao: []
paths:
  /v1/sessoes:
    post:
      tags: [Sessões]
      summary: Entrar
      security: [{ ClientId: [] }]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [usuario, senha]
              properties:
                usuario: { type: string, example: maria }
                senha: { type: string, example: segredo }
      responses:
        '200':
          description: Sessão aberta.
          content:
            application/json:
              schema:
                type: object
                properties:
                  access_token: { type: string, example: abc.def.ghi }
  /v1/sessoes/atual:
    delete:
      tags: [Sessões]
      summary: Sair
      responses:
        '204': { description: Sessão encerrada. }
  /v1/status:
    get:
      summary: Status
      security: []
      responses:
        '200': { description: No ar. }
  /v1/processos/{id}:
    get:
      tags: [Processos]
      summary: Consultar processo
      parameters:
        - { name: id, in: path, required: true, schema: { type: integer }, example: 42 }
        - { name: X-Client-Id, in: header, required: true, schema: { type: string } }
        - { name: campos, in: query, schema: { type: string } }
      responses:
        '200':
          description: O processo.
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Processo' }
        '404': { description: Processo não encontrado. }
`;

/** The fixture imported into the catalog, as the portal stores it. */
export function catalogApi(over: Partial<Api> = {}): Api {
  return {
    ...importOpenApi(SPEC),
    id: 'api-processos',
    slug: 'processos',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  } as Api;
}
