/**
 * Sends e-mail through SMTP_URL (e.g. smtp://usuario:senha@smtp.exemplo.gov.br:587).
 * Without it, messages are written as .eml files to OUTBOX_DIR, so they can be checked locally.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'apis.json');
const OUTBOX_DIR = process.env.OUTBOX_DIR || path.join(path.dirname(DATA_FILE), 'outbox');
const SMTP_URL = process.env.SMTP_URL || '';
const MAIL_FROM = process.env.MAIL_FROM || `${require('./branding').brand().name} <nao-responda@localhost>`;

const transport = SMTP_URL
  ? nodemailer.createTransport(SMTP_URL)
  : nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });

if (!SMTP_URL) console.warn(`[aviso] SMTP_URL não definido — e-mails serão gravados em ${OUTBOX_DIR}.`);

/** @param {{ to: string, subject: string, text: string, html: string, headers?: Record<string, string> }} message */
async function send({ to, subject, text, html, headers }) {
  const info = await transport.sendMail({ from: MAIL_FROM, to, subject, text, html, headers });
  if (!SMTP_URL) {
    fs.mkdirSync(OUTBOX_DIR, { recursive: true });
    const file = path.join(OUTBOX_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}.eml`);
    fs.writeFileSync(file, info.message);
    console.log(`[e-mail] ${to} · ${subject} → ${path.basename(file)}`);
  }
}

module.exports = { send, OUTBOX_DIR, usingSmtp: !!SMTP_URL };
