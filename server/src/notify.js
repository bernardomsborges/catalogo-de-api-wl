/**
 * E-mails for "Acompanhar esta API": the confirmation and the change notices sent when an API gets
 * a new "Novidades" entry or becomes deprecated.
 */
const mailer = require('./mailer');
const subscriptions = require('./subscriptions');
const accounts = require('./accounts');
const branding = require('./branding');

/** Subscribers who may still read the API (a private API only e-mails people with access). */
const recipients = (api) => subscriptions.activeFor(api.id).filter((s) => accounts.canEmailSee(s.email, api));

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code style="background:#f1f3f5;padding:1px 4px;border-radius:4px">$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

/** Minimal Markdown (paragraphs, "- " lists, `code`, **bold**) to e-mail-safe HTML. */
function mdToHtml(md) {
  const out = [];
  let list = [];
  const flush = () => {
    if (list.length) out.push(`<ul style="margin:6px 0 10px;padding-left:20px">${list.map((l) => `<li>${inline(l)}</li>`).join('')}</ul>`);
    list = [];
  };
  for (const line of String(md || '').split(/\r?\n/)) {
    const item = /^\s*[-*]\s+(.*)$/.exec(line);
    if (item) list.push(item[1]);
    else {
      flush();
      if (line.trim()) out.push(`<p style="margin:6px 0">${inline(line)}</p>`);
    }
  }
  flush();
  return out.join('');
}

/**
 * Splits a changelog text into the "Quebra integrações" block (written by the catalog's change
 * review, PRO-163) and everything else.
 */
function splitBreaking(notes) {
  const breaking = [];
  const rest = [];
  let inBreaking = false;
  for (const line of String(notes || '').split(/\r?\n/)) {
    const heading = /^\s*\*\*(.+?)\*\*\s*$/.exec(line);
    if (heading) inBreaking = /quebra/i.test(heading[1]);
    else if (!line.trim()) inBreaking = false;
    if (inBreaking && !heading) breaking.push(line);
    else if (!(heading && inBreaking)) rest.push(line);
  }
  return { breaking: breaking.join('\n').trim(), rest: rest.join('\n').trim() };
}

const unsubscribeUrl = (s) => `${PUBLIC_URL}/acompanhar/cancelar?token=${encodeURIComponent(s.token)}`;
const oneClickUrl = (s) => `${PUBLIC_URL}/api/subscriptions/unsubscribe?token=${encodeURIComponent(s.token)}`;
const apiUrl = (api, tab = '') => `${PUBLIC_URL}/apis/${encodeURIComponent(api.slug)}${tab ? `/${tab}` : ''}`;

function layout(title, bodyHtml, footerHtml) {
  return `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f4f6f8;font-family:Segoe UI,Arial,sans-serif;color:#1f2933">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
<div style="background:#fff;border-radius:10px;padding:24px;border:1px solid #e3e8ee">
<h1 style="font-size:20px;margin:0 0 12px">${esc(title)}</h1>${bodyHtml}</div>
<p style="font-size:12px;color:#6b7785;margin:16px 4px">${footerHtml}</p></div></body></html>`;
}

const button = (url, label) =>
  `<p style="margin:18px 0"><a href="${esc(url)}" style="background:#18181b;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;display:inline-block">${esc(label)}</a></p>`;

async function sendConfirmation(sub, api) {
  const url = `${PUBLIC_URL}/acompanhar/confirmar?token=${encodeURIComponent(sub.token)}`;
  await mailer.send({
    to: sub.email,
    subject: `Confirme: acompanhar a API ${api.name}`,
    text: `Para receber avisos de mudanças na API ${api.name}, confirme neste link:\n${url}\n\nSe não foi você, ignore este e-mail.`,
    html: layout(
      `Acompanhar a API ${api.name}`,
      `<p>Confirme para receber avisos quando a API mudar: versões novas, mudanças que podem quebrar integrações e depreciação.</p>${button(url, 'Confirmar')}`,
      'Se não foi você, ignore este e-mail: nada acontece sem a confirmação.'
    ),
  });
}

function changelogKey(e) {
  return `${e.version}|${e.date}|${e.notes}`;
}

/** What changed between two saved versions of an API that subscribers should hear about. */
function noticeFor(before, after) {
  const known = new Set((before.changelog || []).map(changelogKey));
  const entries = (after.changelog || []).filter((e) => !known.has(changelogKey(e)));
  const deprecated = before.status !== 'depreciada' && after.status === 'depreciada';
  // Already deprecated and the switch-off day was set or moved (PRO-205).
  const sunsetChanged = !deprecated && after.status === 'depreciada' && !!after.sunsetDate && after.sunsetDate !== (before.sunsetDate || '');
  if (!entries.length && !deprecated && !sunsetChanged) return null;
  const parts = entries.map((e) => ({ ...e, ...splitBreaking(e.notes) }));
  return { entries: parts, deprecated, sunsetChanged, breaking: parts.some((p) => p.breaking) };
}

/** 2026-12-31 → 31/12/2026 */
const brDay = (d) => d.split('-').reverse().join('/');

function noticeMail(api, notice, sub) {
  const version = notice.entries[0]?.version || api.version;
  const subject = notice.deprecated
    ? `A API ${api.name} foi depreciada`
    : notice.sunsetChanged
      ? `${api.name} será desligada em ${brDay(api.sunsetDate)}`
      : notice.breaking
        ? `[Atenção] ${api.name} ${version}: mudanças que podem quebrar integrações`
        : `${api.name}: novidades da versão ${version}`;

  let html = '';
  let text = '';
  if (notice.deprecated || notice.sunsetChanged) {
    // When it stops working and what to use instead (PRO-205).
    const replacement = api.replacedBy ? require('./store').get(api.replacedBy) : null;
    const lines = [];
    if (api.sunsetDate) lines.push(`Ela será desligada em ${brDay(api.sunsetDate)}.`);
    if (replacement) lines.push(`Use a API ${replacement.name} no lugar: ${apiUrl(replacement)}`);
    const title = notice.deprecated ? 'Esta API foi depreciada.' : 'A data de desligamento desta API mudou.';
    html += `<div style="border-left:4px solid #c0392b;background:#fdecea;padding:10px 14px;border-radius:6px;margin:8px 0 14px"><strong>${title}</strong> Não inicie novas integrações e planeje a migração.${lines.map((l) => `<br>${esc(l)}`).join('')}</div>`;
    text += `ATENÇÃO: ${title} Não inicie novas integrações e planeje a migração.\n${lines.map((l) => `${l}\n`).join('')}\n`;
  }
  for (const e of notice.entries) {
    html += `<h2 style="font-size:16px;margin:16px 0 6px">Versão ${esc(e.version)} <span style="font-weight:normal;color:#6b7785;font-size:13px">· ${esc(e.date)}</span></h2>`;
    text += `Versão ${e.version} (${e.date})\n`;
    if (e.breaking) {
      html += `<div style="border-left:4px solid #c0392b;background:#fdecea;padding:10px 14px;border-radius:6px;margin:8px 0"><strong style="color:#c0392b">Pode quebrar sua integração</strong>${mdToHtml(e.breaking)}</div>`;
      text += `\n*** PODE QUEBRAR SUA INTEGRAÇÃO ***\n${e.breaking}\n`;
    }
    if (e.rest) {
      html += mdToHtml(e.rest);
      text += `\n${e.rest}\n`;
    }
    text += '\n';
  }
  html += button(apiUrl(api, notice.entries.length ? 'changelog' : ''), 'Ver a API no catálogo');
  text += `Ver a API: ${apiUrl(api, notice.entries.length ? 'changelog' : '')}\n\n`;
  text += `Você recebe este aviso porque acompanha a API ${api.name}. Para deixar de acompanhar: ${unsubscribeUrl(sub)}`;
  const footer = `Você recebe este aviso porque acompanha a API ${esc(api.name)}. <a href="${esc(unsubscribeUrl(sub))}" style="color:#6b7785">Deixar de acompanhar</a>`;
  return {
    to: sub.email,
    subject,
    text,
    html: layout(subject, html, footer),
    // One-click unsubscribe button in Gmail/Outlook (RFC 8058).
    headers: { 'List-Unsubscribe': `<${oneClickUrl(sub)}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  };
}

/** Called after an API is saved: e-mails every active subscriber when there is something new. */
async function onApiUpdated(before, after) {
  const notice = noticeFor(before, after);
  if (!notice) return 0;
  const subs = recipients(after);
  let sent = 0;
  for (const sub of subs) {
    try {
      await mailer.send(noticeMail(after, notice, sub));
      sent++;
    } catch (err) {
      console.error(`[e-mail] falha ao avisar ${sub.email}: ${err.message}`);
    }
  }
  return sent;
}

const lastDownNotice = new Map();
/** Start of the incident whose "down" e-mail went out, by API: only that one gets a "back up" e-mail. */
const notifiedIncident = new Map();
const DOWN_NOTICE_GAP_MS = 30 * 60_000;
const hhmm = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: process.env.TZ || 'America/Sao_Paulo' });

/**
 * Incident notices from the health checks (PRO-160): when an API goes down and when it comes back.
 * At most one "down" e-mail per API every 30 minutes, so an unstable API doesn't flood inboxes.
 */
async function onHealthChange(api, previous, next, entry) {
  const down = next === 'down';
  if (!down && previous !== 'down') return 0;
  const incident = (entry.incidents || []).at(-1);
  if (down) {
    if (Date.now() - (lastDownNotice.get(api.id) || 0) < DOWN_NOTICE_GAP_MS) return 0;
    lastDownNotice.set(api.id, Date.now());
    notifiedIncident.set(api.id, incident?.start);
  } else {
    // "Back up" only for an outage people were told about.
    if (!incident || notifiedIncident.get(api.id) !== incident.start) return 0;
    notifiedIncident.delete(api.id);
  }
  const statusUrl = `${PUBLIC_URL}/status`;
  let subject, body, text;
  if (down) {
    subject = `[Fora do ar] ${api.name}`;
    const error = entry.current?.lastError || '';
    body = `<div style="border-left:4px solid #c0392b;background:#fdecea;padding:10px 14px;border-radius:6px;margin:8px 0 14px"><strong>A API ${esc(api.name)} não está respondendo</strong> desde ${esc(hhmm(incident?.start || new Date().toISOString()))}.${error ? `<br><span style="color:#6b7785">${esc(error)}</span>` : ''}</div><p>Avisaremos quando ela voltar.</p>`;
    text = `A API ${api.name} não está respondendo desde ${hhmm(incident?.start || new Date().toISOString())}.${error ? `
${error}` : ''}
Avisaremos quando ela voltar.`;
  } else {
    subject = `${api.name} voltou a funcionar`;
    const minutes = incident?.start && incident?.end ? Math.max(1, Math.round((Date.parse(incident.end) - Date.parse(incident.start)) / 60_000)) : null;
    body = `<p>A API <strong>${esc(api.name)}</strong> voltou a responder às ${esc(hhmm(entry.current?.lastCheckedAt || new Date().toISOString()))}${minutes ? `, depois de cerca de ${minutes} min fora do ar` : ''}.</p>`;
    text = `A API ${api.name} voltou a responder${minutes ? `, depois de cerca de ${minutes} min fora do ar` : ''}.`;
  }
  let sent = 0;
  for (const sub of recipients(api)) {
    try {
      await mailer.send({
        to: sub.email,
        subject,
        text: `${text}

Status das APIs: ${statusUrl}

Para deixar de acompanhar: ${unsubscribeUrl(sub)}`,
        html: layout(subject, body + button(statusUrl, 'Ver a página de status'), `Você recebe este aviso porque acompanha a API ${esc(api.name)}. <a href="${esc(unsubscribeUrl(sub))}" style="color:#6b7785">Deixar de acompanhar</a>`),
        headers: { 'List-Unsubscribe': `<${oneClickUrl(sub)}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
      });
      sent++;
    } catch (err) {
      console.error(`[e-mail] falha ao avisar ${sub.email}: ${err.message}`);
    }
  }
  return sent;
}

// ----- Accounts: access requests and forgotten password -----

const quote = (t) => `<blockquote style="margin:10px 0;padding:8px 12px;border-left:3px solid #c9d4e1;color:#41506b">${esc(t)}</blockquote>`;

/**
 * New access request: to the administrators (they approve in "Pessoas e acesso") and, for an API,
 * to the team that owns it, so they know who wants to use it.
 */
async function sendAccessRequested(request, { admins, api }) {
  const who = `${request.user?.name} (${request.user?.email})`;
  const target = request.apiId ? `à API ${request.apiName}` : `ao grupo ${request.group?.name}`;
  const url = `${PUBLIC_URL}/admin/pessoas`;
  const subject = `Pedido de acesso ${target}`;
  const reason = request.message ? quote(request.message) : '<p style="color:#6b7785">Sem mensagem.</p>';
  const to = [...new Set([...admins, ...(api?.contactEmail ? [api.contactEmail] : [])].map((e) => e.toLowerCase()))];
  if (!to.length) return 0;
  await mailer.send({
    to: to.join(', '),
    subject,
    text: `${who} pediu acesso ${target}.
${request.message ? `
Motivo: ${request.message}
` : ''}
Para aprovar ou recusar (administradores): ${url}`,
    html: layout(
      subject,
      `<p><strong>${esc(who)}</strong> pediu acesso ${esc(target)}.</p>${reason}${button(url, 'Ver pedidos de acesso')}`,
      api?.contactEmail
        ? `Você recebe este e-mail como administrador do catálogo ou como contato da API ${esc(api.name)}. Quem aprova são os administradores, em Pessoas e acesso.`
        : 'Você recebe este e-mail como administrador do catálogo.'
    ),
  });
  return to.length;
}

/** Answer to an access request, to the person who asked. */
async function sendAccessDecided(request, api) {
  if (!request.user?.email) return 0;
  const approved = request.status === 'approved';
  const target = request.apiId ? `à API ${request.apiName}` : `ao grupo ${request.group?.name}`;
  const subject = approved ? `Acesso liberado ${target}` : `Pedido de acesso ${target} recusado`;
  const url = approved && api ? apiUrl(api) : `${PUBLIC_URL}/conta`;
  const body = approved
    ? `<p>Seu pedido foi aprovado: você agora faz parte do grupo <strong>${esc(request.group?.name || '')}</strong>${request.apiId ? ` e já pode ver a documentação da API <strong>${esc(request.apiName)}</strong>` : ''}.</p>${request.note ? quote(request.note) : ''}${button(url, request.apiId ? 'Abrir a API' : 'Ver minha conta')}<p style="color:#6b7785;font-size:13px">As credenciais da API seguem o processo do time responsável: veja a seção Autenticação na documentação.</p>`
    : `<p>Seu pedido foi recusado.</p>${request.note ? quote(request.note) : ''}<p>Se precisar, peça de novo explicando melhor para que vai usar.</p>${button(url, 'Ver meus pedidos')}`;
  await mailer.send({
    to: request.user.email,
    subject,
    text: `${approved ? 'Seu pedido foi aprovado.' : 'Seu pedido foi recusado.'}${request.note ? `

${request.note}` : ''}

${url}`,
    html: layout(subject, body, `Você recebe este e-mail porque pediu acesso no ${branding.brand().name}.`),
  });
  return 1;
}

/** "Esqueci minha senha": link to set a new password. */
async function sendPasswordReset(user, token, minutes) {
  const url = `${PUBLIC_URL}/redefinir-senha?token=${encodeURIComponent(token)}`;
  await mailer.send({
    to: user.email,
    subject: `Redefinir a sua senha do ${branding.brand().name}`,
    text: `Para criar uma senha nova, abra este link (vale por ${minutes} minutos e só funciona uma vez):
${url}

Se não foi você, ignore este e-mail: sua senha continua a mesma.`,
    html: layout(
      'Redefinir a sua senha',
      `<p>Olá, ${esc(user.name)}. Recebemos um pedido para redefinir a sua senha.</p>${button(url, 'Criar uma senha nova')}<p style="color:#6b7785;font-size:13px">O link vale por ${minutes} minutos e só funciona uma vez.</p>`,
      'Se não foi você, ignore este e-mail: sua senha continua a mesma.'
    ),
  });
}

module.exports = { sendConfirmation, onApiUpdated, onHealthChange, noticeFor, splitBreaking, sendAccessRequested, sendAccessDecided, sendPasswordReset, PUBLIC_URL };
