import { HttpClient } from '@angular/common/http';
import { ArrowKeys } from '../../shared/arrow-keys';
import { AppDialog } from '../../shared/dialog';
import { Consumer } from '../../core/systems';
import { SystemsService } from '../../core/systems.service';
import { Component, computed, inject, input, OnInit, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { ApiInput, CatalogService, DraftInfo, errorMessage } from '../../core/catalog.service';
import { buildGuides, GeneratedGuide } from '../../core/guides';
import { Api, apiSchemes, AuthScheme, emptyApi, emptyScheme, Endpoint, METHODS, SCHEME_LABELS, SchemeType, STATUS_LABELS, ApiStatus, schemeWire } from '../../core/models';
import { bumpVersion, changelogNotes, ChangeReport, compareModels, modelFromApi, modelFromSpecText } from '../../core/breaking';
import { importOpenApi } from '../../core/openapi';
import { diffSpec, mergeSpec, SpecDiff, SpecSyncService, SYNC_AUTH_LABELS, SYNC_SECRET_LABELS, SyncAuthType, SyncConfig, SyncStatus } from '../../core/spec-sync';
import { MarkdownPipe } from '../../shared/markdown.pipe';
import { ChangeReview, ChangeReviewState } from './change-review';
import { ApiHistory } from './api-history';
import { DocAgent, DocAgentSession } from './doc-agent';
import { HealthSettings } from './health-settings';
import { SpecAuthFields } from './spec-auth-fields';
import { DocQuality } from './doc-quality';
import { AccessService, Group } from '../../core/access.service';
import { AuthService } from '../../core/auth';
import { QualityScore } from '../../shared/quality-score';
import { RecipeService } from '../../core/recipe.service';
import { docQuality, Quality } from '../../../../../shared/doc-quality';

const SECTIONS = [
  { id: 'qualidade', label: 'Qualidade' },
  { id: 'basico', label: 'Informações básicas' },
  { id: 'acesso', label: 'Acesso e ambientes' },
  { id: 'visibilidade', label: 'Visibilidade' },
  { id: 'endpoints', label: 'Endpoints' },
  { id: 'guias', label: 'Guias personalizados' },
  { id: 'novidades', label: 'Novidades' },
];
const SYNC_SECTION = { id: 'sincronizacao', label: 'Sincronização do OpenAPI' };
const HEALTH_SECTION = { id: 'monitoramento', label: 'Monitoramento' };
const HISTORY_SECTION = { id: 'historico', label: 'Histórico de versões' };

@Component({
  selector: 'app-api-form',
  imports: [ArrowKeys, AppDialog, FormsModule, RouterLink, MarkdownPipe, SpecAuthFields, ChangeReview, HealthSettings, ApiHistory, DocAgent, DocQuality, QualityScore],
  templateUrl: './api-form.html',
  styleUrl: './api-form.scss',
})
export class ApiForm implements OnInit {
  private catalog = inject(CatalogService);
  private router = inject(Router);
  private specSync = inject(SpecSyncService);
  private http = inject(HttpClient);
  private recipeService = inject(RecipeService);
  private access = inject(AccessService);
  auth = inject(AuthService);
  /** Groups that may be given access to a private API. */
  groups = signal<Group[]>([]);

  /** Route param: present when editing. */
  id = input<string>();

  get sections() {
    return this.id() ? [...SECTIONS, SYNC_SECTION, HEALTH_SECTION, HISTORY_SECTION] : SECTIONS;
  }
  methods = METHODS;
  statuses = Object.entries(STATUS_LABELS) as [ApiStatus, string][];
  schemeTypes = Object.entries(SCHEME_LABELS) as [SchemeType, string][];

  model = signal<ApiInput>(emptyApi());
  tagsText = '';
  loading = signal(false);
  saving = signal(false);
  errors = signal<string[]>([]);
  notice = signal('');
  importOpen = signal(false);
  importMode = signal<'link' | 'arquivo'>('link');
  importForm: SyncConfig = emptySyncForm();
  /** Turn on sync with the link when the API is saved. */
  importKeepSync = true;
  importing = signal(false);
  /** Sync to set up on save: settings typed in the import dialog and the document they returned. */
  private pendingSync: { config: SyncConfig; text: string } | null = null;
  importText = '';
  importError = signal('');
  preview = signal<GeneratedGuide[] | null>(null);
  previewTab = signal(0);
  categories = signal<string[]>([]);
  /** Published version (the form may hold a draft). */
  published = signal<Api | null>(null);
  /** Set when the form holds the API's draft. */
  draftInfo = signal<DraftInfo | null>(null);
  savingDraft = signal(false);
  /** AI provider configured on the server (shows "Melhorar com IA"). */
  aiEnabled = signal(false);
  /** "Melhorar com IA" panel: 'api', an endpoint index, or closed. */
  agentFor = signal<'api' | number | null>(null);
  /** Work of the open panel. Kept per target (whole API or route), so closing the panel loses nothing. */
  agentSession = signal<DocAgentSession | null>(null);
  private agentSessions = new Map<'api' | Endpoint, DocAgentSession>();
  /** Recipes that use this API (count as a guide in the quality score). */
  recipeCount = signal(0);

  // OpenAPI sync (editing only)
  sync = signal<SyncStatus | null>(null);
  syncForm: SyncConfig = emptySyncForm();
  syncAuthTypes = Object.entries(SYNC_AUTH_LABELS) as [SyncAuthType, string][];
  syncSecretLabels = SYNC_SECRET_LABELS;
  syncBusy = signal<'' | 'salvando' | 'sincronizando' | 'aplicando'>('');
  syncError = signal('');
  syncDiff = signal<SpecDiff | null>(null);
  /** What the fetched document changes for consumers (sync section). */
  syncReview = signal<ChangeReviewState | null>(null);
  /** Same, for a document imported in this form (applied on save). */
  importReview = signal<ChangeReviewState | null>(null);

  /** Deprecation (PRO-205): the other APIs, and how many people still follow this one. */
  readonly today = new Date().toISOString().slice(0, 10);
  replacementOptions = computed(() => this.catalog.apis().filter((a) => a.id !== this.id() && a.status !== 'depreciada').sort((a, b) => a.name.localeCompare(b.name)));
  followers = signal<number | null>(null);
  /** Systems that use this API, for the breaking-change review (PRO-166). */
  consumers = signal<Consumer[] | null>(null);
  private systemsService = inject(SystemsService);

  async ngOnInit() {
    firstValueFrom(this.http.get<Record<string, number>>('/api/subscriptions/counts')).then((c) => this.followers.set(this.id() ? c[this.id()!] ?? 0 : 0), () => {});
    this.access.groups().then((g) => this.groups.set(g), () => {});
    firstValueFrom(this.http.get<{ enabled: boolean }>('/api/ai/status')).then((s) => this.aiEnabled.set(s.enabled), () => {});
    this.catalog.refresh().then(() =>
      this.categories.set([...new Set(this.catalog.apis().map((a) => a.category))].sort())
    );
    const id = this.id();
    if (!id) return;
    this.recipeService.list({ api: id }).then((r) => this.recipeCount.set(r.length), () => {});
    this.systemsService.consumersOf(id).then((c) => this.consumers.set(c), () => {});
    this.loading.set(true);
    try {
      const api = await this.catalog.get(id);
      this.published.set(api);
      // An existing draft is what gets edited; the portal keeps showing the published version.
      const draft = await this.catalog.getDraft(id).catch(() => null);
      const { id: _id, createdAt: _c, updatedAt: _u, draft: info, ...rest } = (draft ?? api) as Api & { draft?: DraftInfo };
      this.draftInfo.set(info ?? null);
      this.model.set(this.withSchemes(structuredClone(rest)));
      this.tagsText = rest.tags.join(', ');
      this.specSync.get(api.id).then((s) => this.setSync(s), () => {});
    } catch (e) {
      this.errors.set([errorMessage(e)]);
    } finally {
      this.loading.set(false);
    }
    // Links from the admin list point to a section (sync, quality), which only exists after loading.
    const section = location.hash.slice(1);
    if (this.sections.some((x) => x.id === section)) setTimeout(() => this.scrollTo(section), 100);
  }

  get m() {
    return this.model();
  }

  // ----- credentials -----
  get schemes(): AuthScheme[] {
    return (this.m.auth.schemes ??= []);
  }

  /** Older APIs keep a single auth type; turn it into the credential list the form edits. */
  private withSchemes(m: ApiInput): ApiInput {
    if (!m.auth.schemes?.length) m.auth.schemes = apiSchemes(m).map((s) => ({ ...s }));
    m.auth.mode ??= 'all';
    return m;
  }

  addScheme() {
    const s = emptyScheme();
    s.key = this.uniqueKey('cred');
    this.schemes.push(s);
  }

  removeScheme(i: number) {
    const [gone] = this.schemes.splice(i, 1);
    if (this.m.auth.defaults) this.m.auth.defaults = this.m.auth.defaults.filter((k) => k !== gone.key);
    for (const ep of this.m.endpoints) if (ep.security) ep.security = ep.security.filter((k) => k !== gone.key);
  }

  onSchemeType(s: AuthScheme) {
    if (s.type === 'apiKey' && !s.name) s.name = 'X-API-Key';
  }

  schemeName(s: AuthScheme) {
    return s.type === 'apiKey' ? s.name || '(sem nome)' : `${schemeWire(s).name} (${SCHEME_LABELS[s.type]})`;
  }

  isDefault(s: AuthScheme) {
    return !this.m.auth.defaults || this.m.auth.defaults.includes(s.key);
  }

  toggleDefault(s: AuthScheme) {
    const keys = this.m.auth.defaults ?? this.schemes.map((x) => x.key);
    const next = keys.includes(s.key) ? keys.filter((k) => k !== s.key) : [...keys, s.key];
    // All checked = no special list needed.
    this.m.auth.defaults = this.schemes.every((x) => next.includes(x.key)) ? undefined : next;
  }

  setEpInherit(ep: Endpoint, inherit: boolean) {
    if (inherit) delete ep.security;
    else ep.security = this.schemes.map((s) => s.key);
  }

  toggleEpScheme(ep: Endpoint, key: string) {
    const list = ep.security ?? [];
    ep.security = list.includes(key) ? list.filter((k) => k !== key) : [...list, key];
  }

  private uniqueKey(base: string) {
    const keys = new Set(this.schemes.map((s) => s.key));
    let i = this.schemes.length + 1;
    while (keys.has(`${base}${i}`)) i++;
    return `${base}${i}`;
  }

  /** Keeps the summary fields (type, header name…) in line with the credential list. */
  private syncAuth(m: ApiInput) {
    const schemes = (m.auth.schemes ?? []).filter((s) => s.type !== 'apiKey' || s.name.trim());
    schemes.forEach((s, i) => (s.key ||= `cred${i + 1}`));
    m.auth.schemes = schemes;
    if (m.auth.defaults) {
      const keys = new Set(schemes.map((s) => s.key));
      m.auth.defaults = m.auth.defaults.filter((k) => keys.has(k));
      if (m.auth.defaults.length === schemes.length) delete m.auth.defaults;
    }
    m.auth.type = schemes[0]?.type ?? 'none';
    m.auth.headerName = schemes.find((s) => s.type === 'apiKey')?.name ?? '';
    m.auth.tokenUrl = schemes.find((s) => s.type === 'oauth2')?.tokenUrl ?? '';
    m.auth.scopes = schemes.find((s) => s.type === 'oauth2')?.scopes ?? '';
    if (!schemes.length) m.endpoints.forEach((ep) => delete ep.security);
  }

  // ----- visibility -----
  setVisibility(v: 'public' | 'private') {
    this.m.visibility = v;
    this.m.groups ??= [];
  }
  hasGroup(id: string) {
    return !!this.m.groups?.includes(id);
  }
  toggleGroup(id: string) {
    const list = (this.m.groups ??= []);
    const i = list.indexOf(id);
    if (i >= 0) list.splice(i, 1);
    else list.push(id);
  }

  // ----- list helpers -----
  addEnv() {
    this.m.environments.push({ name: '', url: '' });
  }
  /** Endpoints added by hand in this session: they start expanded; saved and imported ones start collapsed. */
  private openedEndpoints = new WeakSet<Endpoint>();
  isExpanded(ep: Endpoint) {
    return this.openedEndpoints.has(ep);
  }
  /** Groups already used, suggested in the "Grupo" field. */
  endpointGroups() {
    return [...new Set(this.m.endpoints.map((e) => e.tag?.trim()).filter((t): t is string => !!t))].sort();
  }
  /** Opens "Melhorar com IA", resuming what was done before for the same target. */
  openAgent(target: 'api' | number) {
    const key = target === 'api' ? 'api' : this.m.endpoints[target];
    let session = this.agentSessions.get(key);
    // Another API was loaded in the form: start over.
    if (session && session.api !== this.m) session = undefined;
    if (session?.routesChanged()) {
      session = new DocAgentSession(this.m);
      session.notice = 'A lista de rotas mudou desde a última busca, então as sugestões pendentes foram descartadas. Procure de novo.';
    }
    session ??= new DocAgentSession(this.m);
    this.agentSessions.set(key, session);
    this.agentSession.set(session);
    this.agentFor.set(target);
  }
  addEndpoint() {
    const ep: Endpoint = { method: 'GET', path: '/', summary: '', description: '', parameters: [], requestBody: '', responses: [{ status: 200, description: 'Sucesso', body: '' }] };
    this.openedEndpoints.add(ep);
    this.m.endpoints.push(ep);
  }
  duplicateEndpoint(i: number) {
    const copy = structuredClone(this.m.endpoints[i]);
    delete copy.id;
    copy.summary = copy.summary ? copy.summary + ' (cópia)' : '';
    this.openedEndpoints.add(copy);
    this.m.endpoints.splice(i + 1, 0, copy);
  }
  addParam(ep: Endpoint) {
    ep.parameters.push({ name: '', in: 'query', type: 'string', required: false, description: '', example: '' });
  }
  addResponse(ep: Endpoint) {
    ep.responses.push({ status: 400, description: '', body: '' });
  }
  addGuide() {
    this.m.guides.push({ title: '', content: '' });
  }
  addChange() {
    this.m.changelog.unshift({ version: this.m.version, date: new Date().toISOString().slice(0, 10), notes: '' });
  }
  remove<T>(list: T[], i: number) {
    list.splice(i, 1);
  }
  move<T>(list: T[], i: number, delta: number) {
    const j = i + delta;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
  }

  /** Fills path params automatically from "{name}" placeholders in the path. */
  syncPathParams(ep: Endpoint) {
    const names = [...ep.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
    for (const name of names) {
      if (!ep.parameters.some((p) => p.in === 'path' && p.name === name)) {
        ep.parameters.unshift({ name, in: 'path', type: 'string', required: true, description: '', example: '' });
      }
    }
  }

  formatJson(target: { requestBody?: string; body?: string }, key: 'requestBody' | 'body') {
    const value = target[key];
    if (!value?.trim()) return;
    try {
      target[key] = JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      this.notice.set('JSON inválido: verifique vírgulas, aspas e chaves.');
    }
  }

  // ----- OpenAPI import -----
  async onFile(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) this.importText = await file.text();
  }

  openImport() {
    this.importError.set('');
    // Editing an API with sync on: start from its link and credential type.
    const s = this.sync();
    if (s?.configured && !this.importForm.url) this.importForm = { ...this.syncForm, secret: '', clearSecret: false };
    this.importOpen.set(true);
  }

  /** The stored sync secret can be reused: same type and same host. */
  importUsesStoredSecret() {
    const s = this.sync();
    if (!this.id() || !s?.hasSecret || s.authType !== this.importForm.authType) return false;
    try {
      return new URL(s.url!).origin === new URL(this.importForm.url).origin;
    } catch {
      return false;
    }
  }

  async importFromLink() {
    this.importError.set('');
    this.importing.set(true);
    try {
      const config = { ...this.importForm };
      const { text, source, how } = await this.specSync.fetchForImport(config, this.id());
      if (this.runImport(text)) {
        // Found at its own address on the same site: sync straight from there.
        if ((how === 'linked' || how === 'common') && new URL(source).origin === new URL(config.url).origin) config.url = source;
        this.pendingSync = this.importKeepSync ? { config, text } : null;
        this.importForm.secret = '';
        if (how === 'embedded') this.notice.set(this.notice() + ' A especificação estava dentro da página da documentação.');
        else if (how !== 'direct') this.notice.set(this.notice() + ` Especificação encontrada em ${source}.`);
        if (this.pendingSync) this.notice.set(this.notice() + ' A sincronização com o link será ligada ao salvar.');
      }
    } catch (e) {
      this.importError.set(errorMessage(e));
    } finally {
      this.importing.set(false);
    }
  }

  runImport(text = this.importText): boolean {
    this.importError.set('');
    try {
      const draft = importOpenApi(text);
      const current = this.m;
      const before = structuredClone(current);
      // Keep what the admin already filled when the spec leaves it empty.
      this.model.set(this.withSchemes({
        ...draft,
        category: current.category || draft.category,
        status: current.status,
        tags: draft.tags.length ? draft.tags : current.tags,
        guides: current.guides,
        changelog: current.changelog,
        rateLimit: current.rateLimit,
        sla: current.sla,
        name: draft.name || current.name,
        summary: draft.summary || current.summary,
        owner: draft.owner || current.owner,
        contactEmail: draft.contactEmail || current.contactEmail,
        slug: current.slug,
      }));
      this.tagsText = this.m.tags.join(', ');
      this.reviewImport(before, text);
      this.importOpen.set(false);
      this.importText = '';
      this.notice.set(`Especificação importada: ${draft.endpoints.length} endpoint(s). Revise os campos e salve.`);
      // A pasted/uploaded document replaces any link imported before.
      this.pendingSync = null;
      return true;
    } catch (e) {
      this.importError.set((e as Error).message || 'Não foi possível ler o arquivo.');
      return false;
    }
  }

  // ----- OpenAPI sync -----
  private setSync(s: SyncStatus) {
    this.sync.set(s);
    this.syncForm = {
      url: s.url ?? '',
      authType: s.authType ?? 'none',
      headerName: s.headerName ?? '',
      paramName: s.paramName ?? '',
      username: s.username ?? '',
      tokenUrl: s.tokenUrl ?? '',
      clientId: s.clientId ?? '',
      scope: s.scope ?? '',
      secret: '',
      clearSecret: false,
    };
    this.refreshDiff();
  }

  /** Compares the fetched document with the catalog (or with the last applied document). */
  private refreshDiff() {
    const s = this.sync();
    this.syncDiff.set(null);
    if (!s?.latestText) return;
    try {
      const latest = importOpenApi(s.latestText);
      const applied = s.appliedText ? importOpenApi(s.appliedText) : undefined;
      const diff = diffSpec(this.m, latest, applied);
      this.syncDiff.set(diff);
      this.syncReview.set(null);
      if (diff.hasChanges) {
        // Raw documents when both exist (knows required fields); otherwise catalog examples.
        const report = s.appliedText
          ? compareModels(modelFromSpecText(s.appliedText), modelFromSpecText(s.latestText))
          : compareModels(modelFromApi(this.m), modelFromApi(latest));
        // Text/example-only updates still deserve a line.
        for (const c of diff.changed) {
          const route = `${c.method} ${c.path}`;
          if (![...report.breaking, ...report.compatible].some((x) => x.route === route)) {
            report.compatible.push({ breaking: false, route, text: `${c.what.join(', ')} atualizados na documentação` });
          }
        }
        this.syncReview.set(this.makeReview('sync', report, latest.version));
      }
      // Nothing to apply (e.g. the catalog already matches the document): record this version as
      // the base for the next comparison, so the next changes are measured against it.
      const id = this.id();
      if (!diff.hasChanges && s.pending && s.latestHash && id) {
        this.specSync.markApplied(id, s.latestHash).then((next) => this.sync.set(next), () => {});
      }
    } catch (e) {
      this.syncError.set(`Não foi possível ler a especificação baixada: ${(e as Error).message}`);
    }
  }

  async saveSync() {
    const id = this.id();
    if (!id) return;
    this.syncError.set('');
    this.syncBusy.set('salvando');
    try {
      this.setSync(await this.specSync.configure(id, this.syncForm));
    } catch (e) {
      this.syncError.set(errorMessage(e));
    } finally {
      this.syncBusy.set('');
    }
  }

  async checkSync() {
    const id = this.id();
    if (!id) return;
    this.syncError.set('');
    this.syncBusy.set('sincronizando');
    try {
      this.setSync(await this.specSync.check(id));
    } catch (e) {
      this.syncError.set(errorMessage(e));
    } finally {
      this.syncBusy.set('');
    }
  }

  /** Merges the fetched document into the form, saves, and marks that version as applied. */
  async applySync() {
    const id = this.id();
    const s = this.sync();
    if (!id || !s?.latestText || !s.latestHash) return;
    const review = this.syncReview();
    if (this.needsConfirmation(review)) return;
    this.syncError.set('');
    let merged: ApiInput;
    try {
      this.syncAuth(this.m);
      merged = mergeSpec(
        { ...this.m, tags: this.parseTags() },
        importOpenApi(s.latestText),
        s.appliedText ? importOpenApi(s.appliedText) : undefined
      );
    } catch (e) {
      this.syncError.set(`Não foi possível aplicar: ${(e as Error).message}`);
      return;
    }
    if (review) this.applyReview(merged, review);
    this.model.set(this.withSchemes(merged));
    this.tagsText = this.m.tags.join(', ');
    this.syncBusy.set('aplicando');
    const hash = s.latestHash;
    await this.save({
      after: () => this.specSync.markApplied(id, hash),
      message: 'Mudanças da especificação aplicadas',
    });
    this.syncBusy.set('');
  }

  // ----- breaking changes review -----
  private makeReview(source: ChangeReviewState['source'], report: ChangeReport, docVersion: string): ChangeReviewState {
    const current = this.m.version;
    // A new version in the document wins; otherwise bump the catalog's.
    const version = docVersion && docVersion !== current ? docVersion : bumpVersion(current, report.breaking.length > 0);
    return { source, report, version, notes: changelogNotes(report), addToChangelog: true, confirmed: false };
  }

  /** After an import on an existing API: what the new document changes for consumers. */
  private reviewImport(before: ApiInput, text: string) {
    this.importReview.set(null);
    if (!this.id() || !before.endpoints.length) return;
    let report: ChangeReport;
    try {
      const previous = this.sync()?.appliedText;
      report = previous ? compareModels(modelFromSpecText(previous), modelFromSpecText(text)) : compareModels(modelFromApi(before), modelFromApi(this.m));
    } catch {
      return;
    }
    if (!report.breaking.length && !report.compatible.length) return;
    // runImport put the document's version in the form; keep the saved one until the review applies.
    const docVersion = this.m.version;
    this.m.version = before.version;
    this.importReview.set(this.makeReview('import', report, docVersion));
  }

  needsConfirmation(r: ChangeReviewState | null) {
    return !!r && r.report.breaking.length > 0 && !r.confirmed;
  }

  /** Puts the reviewed version and changelog entry in the API. */
  private applyReview(m: ApiInput, r: ChangeReviewState) {
    if (r.version.trim()) m.version = r.version.trim();
    if (r.addToChangelog && r.notes.trim()) {
      m.changelog = [{ version: m.version, date: new Date().toISOString().slice(0, 10), notes: r.notes.trim() }, ...m.changelog];
    }
  }

  /** The stored secret only applies while the auth type stays the same. */
  keepsSecret() {
    const s = this.sync();
    return !!s?.hasSecret && s.authType === this.syncForm.authType;
  }

  formatDate(iso?: string | null) {
    return iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '';
  }

  // ----- preview & save -----
  togglePreview() {
    if (this.preview()) {
      this.preview.set(null);
      return;
    }
    const draft = structuredClone(this.m);
    this.syncAuth(draft);
    const fake: Api = { ...draft, tags: this.parseTags(), id: 'preview', createdAt: '', updatedAt: new Date().toISOString() };
    this.preview.set(buildGuides(fake));
    this.previewTab.set(0);
  }

  private parseTags() {
    return this.tagsText.split(',').map((t) => t.trim()).filter(Boolean);
  }

  private validate(): string[] {
    const m = this.m;
    const errs: string[] = [];
    if (!m.name.trim()) errs.push('Informe o nome da API.');
    if (!m.summary.trim()) errs.push('Informe um resumo curto.');
    if (!/^https?:\/\//.test(m.baseUrl)) errs.push('A URL base deve começar com http:// ou https://.');
    m.endpoints.forEach((ep, i) => {
      if (!ep.path.startsWith('/')) errs.push(`Endpoint ${i + 1}: o caminho deve começar com "/".`);
      for (const [label, v] of [['corpo da requisição', ep.requestBody], ...ep.responses.map((r) => [`resposta ${r.status}`, r.body])]) {
        if (v?.trim()) {
          try {
            JSON.parse(v);
          } catch {
            errs.push(`Endpoint ${i + 1} (${ep.method} ${ep.path}): o ${label} não é um JSON válido.`);
          }
        }
      }
    });
    this.schemes.forEach((s, i) => {
      if (s.type === 'oauth2' && s.tokenUrl && !/^https?:\/\//.test(s.tokenUrl)) errs.push(`Credencial ${i + 1}: a URL do token deve começar com http:// ou https://.`);
    });
    m.environments.forEach((e, i) => {
      if (!e.name.trim() || !/^https?:\/\//.test(e.url)) errs.push(`Ambiente ${i + 1}: informe nome e URL (http/https).`);
    });
    return errs;
  }

  async save(opts?: { after?: () => Promise<unknown>; message?: string }) {
    const review = this.importReview();
    if (this.needsConfirmation(review)) {
      this.errors.set(['A especificação importada quebra integrações: confirme na revisão das mudanças antes de salvar.']);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    const errs = this.validate();
    this.errors.set(errs);
    if (errs.length) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    this.syncAuth(this.m);
    if (review) {
      this.applyReview(this.m, review);
      this.importReview.set(null);
    }
    const payload: ApiInput = {
      ...this.m,
      tags: this.parseTags(),
      endpoints: this.m.endpoints.map((ep) => ({ ...ep, responses: ep.responses.map((r) => ({ ...r, status: Number(r.status) })) })),
    };
    this.saving.set(true);
    try {
      const id = this.id();
      const saved = id ? await this.catalog.publish(id, payload) : await this.catalog.create(payload);
      await opts?.after?.();
      let message = opts?.message ? `${opts.message} em “${saved.name}”.` : `“${saved.name}” foi ${id ? 'atualizada' : 'cadastrada'} com sucesso.`;
      // The API is already saved here: a sync problem is reported, not treated as a save error.
      const syncNote = await this.setUpPendingSync(saved.id);
      if (syncNote) message += ` ${syncNote}`;
      this.router.navigate(['/admin'], { state: { message } });
    } catch (e) {
      this.errors.set([errorMessage(e)]);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally {
      this.saving.set(false);
    }
  }

  /** Saves the form as a draft: nothing changes on the portal until it's published. */
  async saveDraft() {
    const id = this.id();
    if (!id) return;
    const errs = this.validate();
    this.errors.set(errs);
    if (errs.length) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    this.syncAuth(this.m);
    this.savingDraft.set(true);
    try {
      const info = await this.catalog.saveDraft(id, { ...this.m, tags: this.parseTags() });
      this.draftInfo.set(info);
      this.notice.set(`Rascunho salvo às ${new Date(info.updatedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}. O portal continua mostrando a versão publicada.`);
    } catch (e) {
      this.errors.set([errorMessage(e)]);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally {
      this.savingDraft.set(false);
    }
  }

  /** Drops the draft and goes back to the published version. */
  async discardDraft() {
    const id = this.id();
    const api = this.published();
    if (!id || !api || !confirm('Descartar o rascunho? As mudanças não publicadas serão perdidas.')) return;
    try {
      await this.catalog.discardDraft(id);
      const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = api;
      this.model.set(this.withSchemes(structuredClone(rest)));
      this.tagsText = rest.tags.join(', ');
      this.draftInfo.set(null);
      this.notice.set('Rascunho descartado. O formulário mostra a versão publicada.');
    } catch (e) {
      this.errors.set([errorMessage(e)]);
    }
  }

  onRestored(api: Api) {
    this.router.navigate(['/admin'], { state: { message: `Versão restaurada: “${api.name}” agora está na versão ${api.revision}.` } });
  }

  /** Turns on sync with the link imported in this form, using that document as the base. */
  private async setUpPendingSync(apiId: string): Promise<string> {
    const pending = this.pendingSync;
    if (!pending) return '';
    try {
      const d = await this.specSync.configure(apiId, pending.config);
      if (d.lastError) return `A sincronização foi ligada, mas a busca falhou: ${d.lastError}`;
      if (d.latestHash && d.latestText === pending.text) await this.specSync.markApplied(apiId, d.latestHash);
      this.pendingSync = null;
      return 'Sincronização com o link ligada.';
    } catch (e) {
      return `A sincronização não foi ligada: ${errorMessage(e)}`;
    }
  }

  /** Documentation score of what is in the form now (recomputed on every change). */
  quality(): Quality {
    return docQuality(this.m, { recipes: this.recipeCount() });
  }

  /** Jumps to the field of a pending quality item, opening its endpoint when collapsed. */
  goToField(target: string) {
    const el = document.getElementById(fieldId(target));
    if (!el) return;
    const details = el.closest('details');
    if (details) details.open = true;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (el.matches('input, textarea, select')) (el as HTMLElement).focus({ preventScroll: true });
    el.classList.remove('flash');
    void el.offsetWidth; // restart the highlight animation
    el.classList.add('flash');
  }

  scrollTo(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

/** DOM id of the form field for a quality/gap target ("endpoints[2].parameters[0].example" → "epp2-0-example"). */
export function fieldId(target: string): string {
  const fixed: Record<string, string> = { description: 'desc', summary: 'summary', owner: 'owner', contactEmail: 'email', 'auth.instructions': 'authInstr', guides: 'guias', endpoints: 'endpoints' };
  if (fixed[target]) return fixed[target];
  let m = /^endpoints\[(\d+)\]\.(summary|description)$/.exec(target);
  if (m) return (m[2] === 'summary' ? 'eps' : 'epd') + m[1];
  m = /^endpoints\[(\d+)\]\.parameters\[(\d+)\]\.(description|example)$/.exec(target);
  if (m) return `epp${m[1]}-${m[2]}-${m[3]}`;
  m = /^endpoints\[(\d+)\]\.responses\[(\d+)\]\.(description|body)$/.exec(target);
  if (m) return `epr${m[1]}-${m[2]}-${m[3]}`;
  m = /^endpoints\[(\d+)\]\.responses$/.exec(target);
  if (m) return `epr${m[1]}`;
  m = /^auth\.schemes\[(\d+)\]\.description$/.exec(target);
  if (m) return `sch${m[1]}-description`;
  return '';
}

function emptySyncForm(): SyncConfig {
  return { url: '', authType: 'none', headerName: '', paramName: '', username: '', tokenUrl: '', clientId: '', scope: '', secret: '', clearSecret: false };
}
