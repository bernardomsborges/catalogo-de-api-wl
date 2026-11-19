/**
 * Whitelabel: who the portal belongs to. Everything that used to name an organization (page titles,
 * link previews, e-mails, the AI assistants, header and footer) reads it from here.
 *
 * - PORTAL_NAME: name of the portal (default "Catálogo de APIs").
 * - ORG_NAME: organization that publishes the APIs (optional), e.g. "Prefeitura de Exemplo".
 * - PORTAL_DESCRIPTION: one sentence about the portal (home, footer, link previews).
 * - LOGO_URL: image for the header and the footer (optional; https:// or a path served by the portal).
 *   Without it, a neutral symbol and the portal's name are shown.
 *
 * The portal gets these values in index.html (<meta name="portal-brand">), so it doesn't need an
 * extra request to know its own name.
 */
const clean = (v, max) => String(v ?? '').trim().slice(0, max);

function brand() {
  const name = clean(process.env.PORTAL_NAME, 80) || 'Catálogo de APIs';
  const org = clean(process.env.ORG_NAME, 120);
  const description = clean(process.env.PORTAL_DESCRIPTION, 300) || (org ? `Encontre, entenda e integre as APIs de ${org}.` : 'Encontre, entenda e integre as APIs disponíveis.');
  const logo = clean(process.env.LOGO_URL, 500);
  return {
    name,
    org,
    description,
    // Only https:// or a path of the portal itself: never javascript: or data: in an <img>.
    logoUrl: /^(https:\/\/|\/(?!\/))/.test(logo) ? logo : '',
  };
}

/** "Página · Catálogo de APIs" (or just the portal's name). */
function title(page) {
  const { name } = brand();
  return page ? `${page} · ${name}` : name;
}

/** How the AI prompts refer to the catalog: "o Catálogo de APIs (Prefeitura de Exemplo)". */
function promptName() {
  const { name, org } = brand();
  return org ? `${name} (${org})` : name;
}

module.exports = { brand, title, promptName };
