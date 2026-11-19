/**
 * Link previews (PRO-199). The portal is built in the browser, so Teams, Slack and WhatsApp, which
 * don't run scripts, used to see the same blank page for every link. The server now fills the
 * title, description and Open Graph / Twitter tags of index.html for the page being opened.
 *
 * Only what anyone may see goes in: an API's name and summary (also shown for private APIs to
 * people without access), and ReceAPItos open to everyone.
 */
const SITE = 'Catálogo de APIs · Automatiza.MG';
const SITE_DESCRIPTION = 'Encontre, entenda e integre as APIs do Automatiza.MG.';
const IMAGE = '/icon-512.png';

const PAGES = {
  '/apis': { title: `APIs · ${SITE}`, description: 'Todas as APIs do Automatiza.MG, com documentação, exemplos e console de testes.' },
  '/receapitos': { title: `ReceAPItos · ${SITE}`, description: 'Passo a passo de tarefas reais que usam as APIs do Automatiza.MG.' },
  '/status': { title: `Status das APIs · ${SITE}`, description: 'Disponibilidade das APIs do Automatiza.MG nos últimos dias.' },
};

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
  const fallback = { title: SITE, description: SITE_DESCRIPTION, type: 'website' };

  if (parts[0] === 'apis' && parts[1]) {
    const api = findApi(parts[1]);
    if (!api) return fallback;
    return { title: `${api.name} · ${SITE}`, description: clip(api.summary) || `Documentação da API ${api.name}.`, type: 'article' };
  }
  if ((parts[0] === 'receapitos' || parts[0] === 'receitas') && parts[1]) {
    const recipe = findRecipe(parts[1]);
    if (!recipe) return fallback;
    return { title: `${recipe.title} · ReceAPItos · ${SITE}`, description: clip(recipe.goal) || 'Passo a passo com as APIs do Automatiza.MG.', type: 'article' };
  }
  const page = PAGES[`/${parts.join('/')}`];
  return page ? { ...page, type: 'website' } : fallback;
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** index.html with the page's title, description and preview tags. `url`: the page's full address. */
function renderIndex(html, { title, description, type }, { url, origin }) {
  const t = escapeHtml(title);
  const d = escapeHtml(description);
  const tags = [
    `<meta property="og:site_name" content="${escapeHtml(SITE)}">`,
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
