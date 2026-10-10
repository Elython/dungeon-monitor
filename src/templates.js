const fs = require('node:fs');
const { writePrivateJson } = require('./storage');
const { announcement, dashboard } = require('./messages');

const DEFAULTS = Object.freeze({
  opened: '**Dungeon opened: {name}**\nInstance #{instanceId}{detailSuffix}\n{url}\nDetected {time}',
  closed: '**Dungeon closed: {name}**\nInstance #{instanceId}{detailSuffix}\n{url}\nDetected {time}',
  boss_opened: '**Boss room opened: {name}{roomSuffix}**\nInstance #{instanceId}{detailSuffix}\n{url}\nDetected {time}',
  dashboard: '**Active dungeons**\n{health}{dungeons}{lastScan}',
});
const EVENT_FIELDS = new Set(['name', 'instanceId', 'room', 'roomSuffix', 'detail', 'detailSuffix', 'url', 'time']);
const STATUS_FIELDS = new Set(['health', 'dungeons', 'lastScan']);
function clean(value) { return String(value || '').replace(/[\r\n]/g, ' ').replace(/[\\*_`~|<>\[\]]/g, '').slice(0, 160); }
function validateTemplate(type, value) {
  if (!Object.hasOwn(DEFAULTS, type)) throw new Error('Choose opened, closed, boss_opened or dashboard');
  const text = String(value).replace(/\\n/g, '\n');
  if (!text.trim() || text.length > 1500) throw new Error('Message template must contain 1–1,500 characters');
  const allowed = type === 'dashboard' ? STATUS_FIELDS : EVENT_FIELDS;
  for (const match of text.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)) {
    if (!allowed.has(match[1])) throw new Error('Unsupported placeholder {' + match[1] + '}');
  }
  return text;
}
function fill(template, values) { return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_, key) => values[key] || '').slice(0, 1950); }
class TemplateStore {
  constructor(file, owner = 'webhook') {
    this.file = file; this.owner = owner;
    this.data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 1, owner, overrides: {} };
    if (this.data.version !== 1 || this.data.owner !== owner || !this.data.overrides) throw new Error('Message templates belong to another Discord configuration or have an invalid format; use a separate template file');
    for (const [type, text] of Object.entries(this.data.overrides)) validateTemplate(type, text);
  }
  get(type) { if (!Object.hasOwn(DEFAULTS, type)) throw new Error('Unknown message type'); return this.data.overrides[type] || DEFAULTS[type]; }
  set(type, value) { this.data.overrides[type] = validateTemplate(type, value); writePrivateJson(this.file, this.data); }
  reset(type) { this.get(type); delete this.data.overrides[type]; writePrivateJson(this.file, this.data); }
  announcement(event) {
    if (!this.data.overrides[event.type]) return announcement(event);
    const content = fill(this.get(event.type), {
      name: clean(event.name), instanceId: clean(event.instanceId), room: clean(event.roomName),
      roomSuffix: event.roomName ? ' — ' + clean(event.roomName) : '', detail: clean(event.detail),
      detailSuffix: event.detail ? ' · ' + clean(event.detail) : '',
      url: new URL(event.url, 'https://demonicscans.org').toString(), time: '<t:' + Math.floor(event.observedAt / 1000) + ':f>',
    });
    return { content, allowed_mentions: { parse: [] } };
  }
  dashboard(state) {
    if (!this.data.overrides.dashboard) return dashboard(state);
    const dungeons = dashboard({ ...state, health: null, lastScanAt: null }).content.replace(/^\*\*Active dungeons\*\*\n/, '');
    const health = state.health?.status === 'error' ? 'Monitoring unavailable: ' + clean(state.health.detail) + '. Showing last verified state.\n'
      : state.health?.status === 'partial' ? 'Some room information is unavailable: ' + clean(state.health.detail) + '\n' : '';
    return { content: fill(this.get('dashboard'), { dungeons, health,
      lastScan: state.lastScanAt ? '\nLast successful scan: <t:' + Math.floor(state.lastScanAt / 1000) + ':f>' : '' }), allowed_mentions: { parse: [] } };
  }
  preview(type, now = Date.now()) {
    if (type !== 'dashboard') return this.announcement({ type, instanceId: '12345', name: 'Example Dungeon', roomName: type === 'boss_opened' ? 'Example Boss Room' : null,
      detail: type === 'closed' ? 'cleared' : '', url: '/guild_dungeon.php', observedAt: now });
    return this.dashboard({ initialized: true, health: { status: 'ok' }, lastScanAt: now, instances: {
      demo: { name: 'Example Dungeon', instanceId: '12345', active: true, url: '/guild_dungeon.php', rooms: { demo: { name: 'Example Boss Room', status: 'open' } } },
    } });
  }
}
module.exports = { TemplateStore, DEFAULTS, validateTemplate };

