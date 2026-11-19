/**
 * /sitemap.xml and /robots.txt (PRO-207), so search engines (the intranet's included) find the pages
 * of the APIs and ReceAPItos, which only exist after the portal runs in the browser.
 * Only what anyone may see goes in: the caller passes the public APIs and the ReceAPItos open to all.
 */
const escapeXml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

/** YYYY-MM-DD, or nothing when the date is missing or invalid. */
function day(value) {
  const d = value ? new Date(value) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : null;
}

function sitemapXml({ origin, apis = [], recipes = [] }) {
  const newest = (list) => list.map((x) => day(x.updatedAt)).filter(Boolean).sort().pop() || null;
  const pages = [
    { path: '/', lastmod: newest([...apis, ...recipes]) },
    { path: '/apis', lastmod: newest(apis) },
    { path: '/receapitos', lastmod: newest(recipes) },
    { path: '/status', lastmod: null },
    ...apis.map((a) => ({ path: `/apis/${encodeURIComponent(a.slug)}`, lastmod: day(a.updatedAt) })),
    ...recipes.map((r) => ({ path: `/receapitos/${encodeURIComponent(r.slug)}`, lastmod: day(r.updatedAt) })),
  ];
  const urls = pages.map((p) => `  <url><loc>${escapeXml(origin + p.path)}</loc>${p.lastmod ? `<lastmod>${p.lastmod}</lastmod>` : ''}</url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

/** Points to the sitemap and keeps crawlers out of the admin, the account pages and the API. */
function robotsTxt({ origin }) {
  return ['User-agent: *', 'Disallow: /api/', 'Disallow: /admin', 'Disallow: /conta', 'Disallow: /entrar', 'Disallow: /cadastro', '', `Sitemap: ${origin}/sitemap.xml`, ''].join('\n');
}

module.exports = { sitemapXml, robotsTxt };
