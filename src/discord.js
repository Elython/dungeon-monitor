const { announcement, dashboard } = require('./messages');
const crypto = require('node:crypto');
const { alertPayload } = require('./watcherMessages');

class DiscordPublisher {
  constructor(config, store, { fetcher = fetch, now = () => Date.now(), preview = false, log = console.log, token = null, templates = null, settings = null } = {}) {
    this.config = config; this.store = store; this.fetcher = fetcher; this.now = now; this.preview = preview; this.log = log;
    this.token = token; this.templates = templates; this.settings = settings; this.tail = Promise.resolve();
  }
  async request(method, suffix, payload, signal, channelId = this.channelId()) {
    if (!this.token || !/^\d{1,30}$/.test(channelId || '')) throw new Error('Discord bot token or announcement channel is missing');
    const url = new URL('https://discord.com/api/v10/channels/' + channelId + '/messages' + suffix.replace(/^\/messages/, ''));
    try {
      const response = await this.fetcher(url, { method, redirect: 'error', headers: { 'Content-Type': 'application/json', Authorization: 'Bot ' + this.token },
        body: JSON.stringify(payload),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000) });
      let result = null; try { result = await response.json(); } catch { /* an empty response cannot confirm a create */ }
      if (response.status === 429) {
        const seconds = Number(result?.retry_after ?? response.headers.get('retry-after'));
        return { status: 'rate_limited', retryAt: this.now() + Math.max(1, Number.isFinite(seconds) ? seconds : 60) * 1000 };
      }
      if (response.status === 404 && method === 'PATCH') return { status: 'missing' };
      if (response.status >= 400 && response.status < 500) return { status: 'failed', error: 'Discord rejected the request (HTTP ' + response.status + ')' };
      if (!response.ok || !/^\d+$/.test(String(result?.id || ''))) return { status: 'uncertain', error: 'Discord did not confirm whether the message was saved' };
      return { status: 'delivered', messageId: String(result.id) };
    } catch {
      return { status: 'uncertain', error: 'Discord response was lost or timed out; automatic reposting is suspended' };
    }
  }
  _serialized(action) {
    const run = this.tail.then(action, action); this.tail = run.catch(() => {}); return run;
  }
  channelId() { return this.settings ? this.settings.channelId() : this.config.channelId; }
  decorate(type, payload, notify = true) { return this.settings ? this.settings.decorate(type, payload, notify) : payload; }
  changeChannel(id) { return this._serialized(async () => { this.settings.setChannel(id); }); }
  changeMention(type, rule) { return this._serialized(async () => { this.settings.setMention(type, rule); }); }
  announcement(event) { return event.type === 'damage_watch' ? alertPayload(event) : this.decorate(event.type, this.templates ? this.templates.announcement(event) : announcement(event)); }
  dashboard(state) { return this.templates ? this.templates.dashboard(state) : dashboard(state); }
  sendTest(type, signal, { ping = false } = {}) {
    return this._serialized(async () => {
      if (this.preview) return { status: 'failed', error: 'Discord posting is disabled' };
      const payload = this.decorate(type, this.templates.preview(type, this.now()), ping);
      return this.request('POST', '', { ...payload, content: '[TEST — not a real dungeon event]\n' + payload.content.slice(0, 1900) }, signal);
    });
  }
  publish(signal, options = {}) { return this._serialized(() => this._publish(signal, options)); }
  async _publish(signal, { dashboardOnly = false } = {}) {
    const state = this.store.state;
    if (this.preview) {
      for (const event of Object.values(state.outbox).filter(row => row.status === 'queued')) {
        const payload = this.announcement(event);
        this.log('[PREVIEW] ' + payload.content + (payload.embeds ? ' ' + JSON.stringify(payload.embeds) : ''));
        event.status = 'preview';
      }
      this.log(this.dashboard(state).content);
      this.store.save(); return;
    }
    if (!this.token) throw new Error('Configure the Discord bot token before starting');
    if (!dashboardOnly) {
      const limitedChannels = new Map();
      let watchPosts = 0;
      for (const event of Object.values(state.outbox).filter(row => row.status === 'queued' && (row.type === 'damage_watch' || this.config.announcements))) {
        signal?.throwIfAborted();
        if (event.type === 'damage_watch' && this.watcherSettings) {
          const rule = this.watcherSettings.data.rules[event.ruleId];
          if (!rule?.enabled || rule.revision !== event.ruleRevision || this.watcherSettings.data.ignoredPlayerIds.includes(event.playerId)) {
            event.status = 'cancelled'; event.error = 'Watcher rule changed, paused, deleted, or player was ignored before delivery'; this.store.save(); continue;
          }
        }
        if (Number(event.retryAt || 0) > this.now()) continue;
        const destination = event.channelId || this.channelId();
        if (limitedChannels.has(destination)) { event.retryAt = limitedChannels.get(destination); continue; }
        if (event.type === 'damage_watch' && watchPosts++ >= 10) continue;
        event.status = 'sending'; this.store.save();
        const result = await this.request('POST', '', this.announcement(event), signal, destination);
        if (result.status === 'rate_limited') limitedChannels.set(destination, result.retryAt);
        Object.assign(event, result, { status: result.status === 'rate_limited' ? 'queued' : result.status });
        this.store.save();
        if (result.status !== 'delivered') {
          this.log(result.error || 'Discord rate limit; next attempt is deferred');
          if (event.type !== 'damage_watch') return;
        }
      }
    }
    if (!this.config.dashboard) return;
    const identity = 'bot:' + this.config.applicationId + ':' + this.channelId();
    if (state.dashboard.identity && state.dashboard.identity !== identity) state.dashboard = {};
    state.dashboard.identity = identity;
    const body = this.decorate('dashboard', this.dashboard(state));
    const hash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const current = state.dashboard;
    if (current.hash === hash || Number(current.retryAt || 0) > this.now() || (current.uncertain && !current.messageId) || current.failed) return;
    const method = current.messageId ? 'PATCH' : 'POST';
    current.sending = true; this.store.save();
    const result = await this.request(method, current.messageId ? '/messages/' + current.messageId : '', method === 'PATCH' ? { ...body, allowed_mentions: { parse: [], users: [], roles: [] } } : body, signal);
    delete current.sending;
    if (result.status === 'delivered') { Object.assign(current, { messageId: result.messageId, hash, uncertain: false }); delete current.retryAt; }
    else if (result.status === 'rate_limited') current.retryAt = result.retryAt;
    else if (result.status === 'missing') { delete current.messageId; delete current.hash; current.uncertain = false; }
    else if (result.status === 'uncertain') { current.uncertain = true; this.log(result.error); }
    else { current.failed = true; this.log(result.error); }
    this.store.save();
  }
}
module.exports = { DiscordPublisher };
