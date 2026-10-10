const fs = require('node:fs');
const crypto = require('node:crypto');
const { writePrivateJson } = require('./storage');
const { integer, idPattern } = require('./damageParser');

function normalizeRule(input) {
  const rule = { ...input };
  for (const field of ['name', 'dungeonName', 'monsterName']) {
    rule[field] = String(rule[field] || '').trim();
    if (!rule[field] || rule[field].length > 160) throw new Error('Choose a rule name, dungeon and monster (up to 160 characters each)');
  }
  rule.threshold = integer(rule.threshold);
  rule.occurrences = Number(rule.occurrences);
  if (!Number.isInteger(rule.occurrences) || rule.occurrences < 1 || rule.occurrences > 10000) throw new Error('Choose between 1 and 10,000 qualifying monsters');
  rule.upper = rule.upper === null || rule.upper === undefined || rule.upper === '' ? null : integer(rule.upper);
  if (rule.upper !== null && BigInt(rule.upper) <= BigInt(rule.threshold)) throw new Error('Choose an immediate limit H greater than X, or leave H empty');
  if (rule.channelId && !idPattern.test(rule.channelId)) throw new Error('Choose a valid notification channel');
  if (rule.roleId && !idPattern.test(rule.roleId)) throw new Error('Choose a valid ping role');
  rule.channelId ||= null; rule.roleId ||= null;
  rule.enabled = rule.enabled === true;
  if (rule.enabled && !rule.channelId) throw new Error('Choose a notification channel before enabling this rule');
  if (!/^[a-f0-9]{16}$/.test(rule.id) || !Number.isSafeInteger(rule.revision) || rule.revision < 1) throw new Error('Watcher rule identity is invalid');
  return rule;
}
class WatcherStore {
  constructor(file, owner) {
    this.file = file; this.owner = owner;
    this.data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 1, owner, rules: {}, ignoredPlayerIds: [], ignoredRevision: 1 };
    if (this.data.version !== 1 || this.data.owner !== owner || !this.data.rules || !Array.isArray(this.data.ignoredPlayerIds)) throw new Error('Watcher settings belong to another Discord server or are invalid');
    for (const [id, rule] of Object.entries(this.data.rules)) {
      if (id !== rule.id) throw new Error('Watcher rule identity is invalid');
      this.data.rules[id] = normalizeRule(rule);
    }
    this.data.ignoredPlayerIds = this.validateIds(this.data.ignoredPlayerIds);
    this.data.ignoredRevision ||= 1;
    if (!Number.isSafeInteger(this.data.ignoredRevision) || this.data.ignoredRevision < 1 || this.rules().length > 25) throw new Error('Watcher settings are invalid; preserve the file for inspection');
  }
  rules() { return Object.values(this.data.rules); }
  get(id) { const rule = this.data.rules[id]; if (!rule) throw new Error('This watcher rule was deleted. Open /watcher again.'); return rule; }
  commit(data) { writePrivateJson(this.file, data); this.data = data; }
  add(input) {
    if (this.rules().length >= 25) throw new Error('Choose at most 25 watcher rules');
    const rule = normalizeRule({ ...input, enabled: false, id: crypto.randomBytes(8).toString('hex'), revision: 1 });
    this.commit({ ...this.data, rules: { ...this.data.rules, [rule.id]: rule } }); return rule;
  }
  update(id, revision, changes) {
    const current = this.get(id);
    if (current.revision !== Number(revision)) throw new Error('This panel is outdated. Open /watcher again before changing settings.');
    const rule = normalizeRule({ ...current, ...changes, id, revision: current.revision + 1 });
    this.commit({ ...this.data, rules: { ...this.data.rules, [id]: rule } }); return rule;
  }
  remove(id, revision) {
    const current = this.get(id);
    if (current.revision !== Number(revision)) throw new Error('This panel is outdated. Open /watcher again.');
    const rules = { ...this.data.rules }; delete rules[id]; this.commit({ ...this.data, rules });
  }
  validateIds(ids) {
    if (!Array.isArray(ids) || ids.length > 250 || ids.some(id => typeof id !== 'string' || !idPattern.test(id)) || ids.join(' ').length > 3900) throw new Error('Choose up to 250 numeric game player IDs; names and Discord IDs are not matched');
    return [...new Set(ids)];
  }
  ignore(ids, revision = this.data.ignoredRevision) {
    if (Number(revision) !== this.data.ignoredRevision) throw new Error('This ignored-player panel is outdated. Open /watcher again.');
    this.commit({ ...this.data, ignoredPlayerIds: this.validateIds(ids), ignoredRevision: this.data.ignoredRevision + 1 });
  }
}
module.exports = { WatcherStore, normalizeRule };
