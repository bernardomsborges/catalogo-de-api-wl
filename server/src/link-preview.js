/**
 * Link previews (PRO-199). The portal is built in the browser, so Teams, Slack and WhatsApp, which
 * don't run scripts, used to see the same blank page for every link. The server now fills the
 * title, description and Open Graph / Twitter tags of index.html for the page being opened.
 *
 * Only what anyone may see goes in: an API's name and summary (also shown for private APIs to
 * people without access), and ReceAPItos open to everyone.
 */
const branding = require('./branding');

const IMAGE = '/icon-512.png';

/** Fixed pages of the portal, with the portal's name (see branding.js). */
function pages() {
  return {
    '/apis': { title: branding.title('APIs'), description: 'Todas as APIs do catálogo, com documentação, exemplos e console de testes.' },
    '/receapitos': { title: branding.title('ReceAPItos'), description: 'Passo a passo de tarefas reais feitas com as APIs do catálogo.' },
    '/status': { title: branding.title('Status das APIs'), description: 'Disponibilidade das APIs do catálogo nos últimos dias.' },
  };
}

const clip = (s, max = 200) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

function decode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return '';
  }
}

/**
 * Title and description for a path of the portal. `findApi(slug)` returns what an anonymous visitor
 * may see of the API (or nothing); `findRecipe(slug)` returns the ReceAPIto only if it's open to all.
 */
function previewFor(pathname, { findApi, findRecipe }) {
  const parts = pathname.split('/').filter(Boolean).map(decode);
  const { name, description } = branding.brand();
  const fallback = { title: name, description, type: 'website' };

  if (parts[0] === 'apis' && parts[1]) {
    const api = findApi(parts[1]);
    if (!api) return fallback;
    return { title: branding.title(api.name), description: clip(api.summary) || `Documentação da API ${api.name}.`, type: 'article' };
  }
  if ((parts[0] === 'receapitos' || parts[0] === 'receitas') && parts[1]) {
    const recipe = findRecipe(parts[1]);
    if (!recipe) return fallback;
    return { title: branding.title(`${recipe.title} · ReceAPItos`), description: clip(recipe.goal) || 'Passo a passo com as APIs do catálogo.', type: 'article' };
  }
  const page = pages()[`/${parts.join('/')}`];
  return page ? { ...page, type: 'website' } : fallback;
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** index.html with the page's title, description and preview tags. `url`: the page's full address. */
function renderIndex(html, { title, description, type }, { url, origin }) {
  const t = escapeHtml(title);
  const d = escapeHtml(description);
  const tags = [
    // Whitelabel: the portal reads its name, organization and logo from here (see branding.js).
    `<meta name="portal-brand" content="${escapeHtml(JSON.stringify(branding.brand()))}">`,
    `<meta property="og:site_name" content="${escapeHtml(branding.brand().name)}">`,
    `<meta property="og:type" content="${type}">`,
    `<meta property="og:title" content="${t}">`,
    `<meta property="og:description" content="${d}">`,
    `<meta property="og:url" content="${escapeHtml(url)}">`,
    `<meta property="og:image" content="${escapeHtml(origin + IMAGE)}">`,
    `<meta property="og:image:width" content="512">`,
    `<meta property="og:image:height" content="512">`,
    `<meta property="og:locale" content="pt_BR">`,
    `<meta name="twitter:card" content="summary">`,
    `<meta name="twitter:title" content="${t}">`,
    `<meta name="twitter:description" content="${d}">`,
  ].join('\n  ');
  return html
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${t}</title>`)
    .replace(/<meta name="description"[^>]*>/, `<meta name="description" content="${d}">`)
    .replace('</head>', `  ${tags}\n</head>`);
}

module.exports = { previewFor, renderIndex };
