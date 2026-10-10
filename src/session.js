const fs = require('node:fs');
const crypto = require('node:crypto');
const { BASE_URL } = require('./config');
const { writePrivateJson } = require('./storage');

const HOST = new URL(BASE_URL).hostname;
function normalizeCookie(cookie) {
  const domain = String(cookie.domain || HOST).toLowerCase().replace(/^\./, '');
  if (domain !== HOST || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(cookie.name || '') || /[\r\n;]/.test(String(cookie.value ?? ''))) return null;
  let expires = Number(cookie.expires ?? cookie.expirationDate ?? -1);
  if (!Number.isFinite(expires)) expires = -1;
  return { name: cookie.name, value: String(cookie.value ?? ''), domain, path: String(cookie.path || '/'), secure: cookie.secure !== false, expires };
}
function fromHar(har) {
  const cookies = new Map(); let userAgent = '';
  for (const entry of har?.log?.entries || []) {
    let url; try { url = new URL(entry.request?.url); } catch { continue; }
    if (url.origin !== BASE_URL) continue;
    const headers = entry.request.headers || [];
    const agent = headers.find(header => header.name.toLowerCase() === 'user-agent');
    if (agent?.value) userAgent = agent.value;
    const supplied = entry.request.cookies?.length ? entry.request.cookies :
      String(headers.find(header => header.name.toLowerCase() === 'cookie')?.value || '').split(';').map(part => {
        const index = part.indexOf('='); return { name: part.slice(0, index).trim(), value: part.slice(index + 1) };
      });
    for (const cookie of supplied) { const normalized = normalizeCookie(cookie); if (normalized) cookies.set(normalized.name + normalized.path, normalized); }
  }
  return { version: 1, userAgent, cookies: [...cookies.values()] };
}
function importSession(sourceFile, destination, userAgent = '') {
  const raw = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
  const session = raw.log?.entries ? fromHar(raw) : {
    version: 1, userAgent: userAgent || raw.userAgent || '', cookies: (Array.isArray(raw) ? raw : raw.cookies || []).map(normalizeCookie).filter(Boolean),
  };
  session.userAgent ||= userAgent;
  if (!session.userAgent || /[\r\n]/.test(session.userAgent)) throw new Error('The session needs the User-Agent from the same browser that logged in');
  if (!session.cookies.some(cookie => cookie.name === 'demon' && /^\d{1,30}$/.test(cookie.value))) throw new Error('No signed-in game account cookie was found in the export');
  writePrivateJson(destination, session);
  return session;
}
class Session {
  constructor(file, now = () => Date.now()) { this.file = file; this.now = now; this.reload(); }
  reload() {
    if (!fs.existsSync(this.file)) throw new Error('Import the monitoring account session first: npm run check explains the setup');
    const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (!parsed.userAgent || /[\r\n]/.test(parsed.userAgent)) throw new Error('Session User-Agent is missing or invalid');
    this.userAgent = parsed.userAgent;
    this.cookies = (parsed.cookies || []).map(normalizeCookie).filter(Boolean);
    this.modified = fs.statSync(this.file).mtimeMs;
  }
  reloadIfChanged() { if (fs.statSync(this.file).mtimeMs !== this.modified) this.reload(); }
  header(url) {
    const target = new URL(url);
    if (target.origin !== BASE_URL) throw new Error('Game cookies may only be sent to the verified game origin');
    return this.cookies.filter(cookie => (cookie.expires < 0 || cookie.expires * 1000 > this.now())
      && target.pathname.startsWith(cookie.path)).sort((a, b) => b.path.length - a.path.length)
      .map(cookie => cookie.name + '=' + cookie.value).join('; ');
  }
  owner() {
    const id = this.cookies.find(cookie => cookie.name === 'demon' && (cookie.expires < 0 || cookie.expires * 1000 > this.now()))?.value;
    if (!/^\d{1,30}$/.test(id || '')) throw Object.assign(new Error('The monitoring account session has expired'), { code: 'AUTH_REQUIRED' });
    return crypto.createHash('sha256').update(id).digest('hex');
  }
  applySetCookies(headers) {
    if (fs.statSync(this.file).mtimeMs !== this.modified) {
      this.reload();
      throw Object.assign(new Error('Session was replaced while a read was running; rescan with the new account'), { code: 'AUTH_REQUIRED' });
    }
    let changed = false;
    for (const value of headers.getSetCookie?.() || []) {
      const [pair, ...attributes] = value.split(';'); const index = pair.indexOf('=');
      if (index < 1) continue;
      const cookie = { name: pair.slice(0, index).trim(), value: pair.slice(index + 1), domain: HOST, path: '/', expires: -1 };
      for (const attribute of attributes) {
        const [key, ...rest] = attribute.trim().split('='); const text = rest.join('=');
        if (key.toLowerCase() === 'domain') cookie.domain = text;
        if (key.toLowerCase() === 'path') cookie.path = text;
        if (key.toLowerCase() === 'expires') cookie.expires = Date.parse(text) / 1000;
        if (key.toLowerCase() === 'max-age') cookie.expires = this.now() / 1000 + Number(text);
      }
      const normalized = normalizeCookie(cookie); if (!normalized) continue;
      this.cookies = this.cookies.filter(old => old.name !== normalized.name || old.path !== normalized.path);
      if (normalized.expires < 0 || normalized.expires * 1000 > this.now()) this.cookies.push(normalized);
      changed = true;
    }
    if (changed) { writePrivateJson(this.file, { version: 1, userAgent: this.userAgent, cookies: this.cookies }); this.modified = fs.statSync(this.file).mtimeMs; }
  }
}
module.exports = { Session, importSession, fromHar };
