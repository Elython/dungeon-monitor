const { setTimeout: sleep } = require('node:timers/promises');
const { BASE_URL } = require('./config');

const READ_PATHS = new Set(['/game_dash.php', '/guild_dungeon.php', '/guild_dungeon_enter.php', '/guild_dungeon_instance.php', '/guild_dungeon_cube.php', '/guild_dungeon_location.php', '/battle.php']);
function problem(message, code) { return Object.assign(new Error(message), { code }); }
function safeGameUrl(value) {
  const url = new URL(value, BASE_URL);
  if (url.origin !== BASE_URL || url.username || url.password || !READ_PATHS.has(url.pathname)) throw problem('Unverified game read route was rejected', 'INVALID_ROUTE');
  const fields = ['/guild_dungeon_enter.php', '/guild_dungeon_instance.php'].includes(url.pathname) ? ['id']
    : url.pathname === '/guild_dungeon_cube.php' ? ['instance_id']
      : url.pathname === '/guild_dungeon_location.php' ? ['instance_id', 'location_id']
        : url.pathname === '/battle.php' ? ['instance_id', 'dgmid'] : [];
  for (const key of url.searchParams.keys()) {
    if (!fields.includes(key) && key !== 'cookie_test') throw problem('Unverified game read parameters were rejected', 'INVALID_ROUTE');
  }
  for (const key of fields) if (url.searchParams.getAll(key).length !== 1 || !/^\d{1,30}$/.test(url.searchParams.get(key) || '')) throw problem('Game read locator is missing or invalid', 'INVALID_ROUTE');
  url.hash = '';
  return url;
}
function isChallengeResponse(headers, html = '') {
  // Cloudflare's official response signal is present on interstitial challenge pages.
  if (String(headers.get('cf-mitigated') || '').toLowerCase() === 'challenge') return true;
  // Ordinary authenticated pages can include challenge-platform/jsd scripts.
  // Script text, CSS and comments are not rendered challenge-screen evidence.
  const markup = String(html).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  return /<title\b[^>]*>\s*Just a moment(?:\.{0,3}|…)?\s*<\/title>/i.test(markup)
    || /<[^>]+\bid=["']challenge-stage["']/i.test(markup);
}

class GameReader {
  constructor(session, config, fetcher = fetch) { this.session = session; this.config = config; this.fetcher = fetcher; this.lastRead = 0; }
  async get(value, signal) {
    let url = safeGameUrl(value);
    for (let redirects = 0; redirects < 4; redirects++) {
      signal?.throwIfAborted();
      const gap = this.config.requestGapMilliseconds - (Date.now() - this.lastRead);
      if (gap > 0) await sleep(gap, undefined, { signal });
      this.lastRead = Date.now();
      let response;
      try {
        response = await this.fetcher(url, { method: 'GET', redirect: 'manual',
          headers: { Cookie: this.session.header(url), 'User-Agent': this.session.userAgent, Accept: 'text/html' },
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.config.requestTimeoutSeconds * 1000)]) : AbortSignal.timeout(this.config.requestTimeoutSeconds * 1000) });
      } catch (error) {
        if (signal?.aborted) throw error;
        throw problem('Game page request failed or timed out', 'READ_FAILED');
      }
      this.session.applySetCookies(response.headers);
      if (isChallengeResponse(response.headers)) throw problem('The game requires a manual browser challenge; re-import the session after completing it', 'CHALLENGE_REQUIRED');
      if (response.status >= 300 && response.status < 400) {
        const destination = new URL(response.headers.get('location') || '', url);
        if (/\/signin\.php|\/login/i.test(destination.pathname)) throw problem('Game login expired; import a fresh session', 'AUTH_REQUIRED');
        if (destination.pathname === '/guild_join_create.php') throw problem('The monitoring account is not in a guild', 'NOT_IN_GUILD');
        url = safeGameUrl(destination); continue;
      }
      const length = Number(response.headers.get('content-length') || 0);
      if (length > 2 * 1024 * 1024) throw problem('Game response exceeded the read limit', 'READ_FAILED');
      const chunks = []; let bytes = 0;
      for await (const part of response.body || []) {
        const chunk = Buffer.from(part); bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) throw problem('Game response exceeded the read limit', 'READ_FAILED');
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks).toString('utf8');
      if (isChallengeResponse(response.headers, body)) throw problem('The game requires a manual browser challenge; re-import the session after completing it', 'CHALLENGE_REQUIRED');
      if (/<input\b[^>]*type=["']password/i.test(body) || /^(?:\s|<[^>]*>)*(?:Access denied|Not logged in)/i.test(body)) throw problem('Game login expired; import a fresh session', 'AUTH_REQUIRED');
      if (response.status === 403 && /You are not in a guild\./i.test(body)) throw problem('The monitoring account is not in a guild', 'NOT_IN_GUILD');
      if (!response.ok) throw problem('Game read returned HTTP ' + response.status, 'READ_FAILED');
      return { body, url: url.toString() };
    }
    throw problem('Game page redirected too many times', 'READ_FAILED');
  }
}
module.exports = { GameReader, safeGameUrl, problem, isChallengeResponse };
