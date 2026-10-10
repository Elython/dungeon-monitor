const fs = require('node:fs');
const { writePrivateJson } = require('./storage');
const { DEFAULTS } = require('./templates');

function validateMention(type, rule) {
  if (!Object.hasOwn(DEFAULTS, type)) throw new Error('Unknown message type');
  if (!['none', 'role', 'everyone'].includes(rule?.kind)) throw new Error('Choose no ping, a role or everyone');
  if (rule.kind !== 'role') return { kind: rule.kind };
  const ids = rule.roleIds ?? (rule.roleId ? [rule.roleId] : []);
  if (!Array.isArray(ids) || !ids.length || ids.length > 25 || ids.some(id => typeof id !== 'string' || !/^\d{1,30}$/.test(id))) {
    throw new Error('Choose between 1 and 25 roles to ping');
  }
  const roleIds = [...new Set(ids)];
  return { kind: 'role', roleIds, roleId: roleIds[0] };
}
class OperatorSettings {
  constructor(file, config) {
    this.file = file; this.config = config; this.owner = config.applicationId + ':' + config.guildId;
    this.data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8'))
      : { version: 1, owner: this.owner, channelId: null, mentions: {} };
    if (this.data.version !== 1 || this.data.owner !== this.owner || !this.data.mentions
      || (this.data.channelId && !/^\d{1,30}$/.test(this.data.channelId))) throw new Error('Discord operator settings belong to another server or have an invalid format');
    for (const [type, rule] of Object.entries(this.data.mentions)) this.data.mentions[type] = validateMention(type, rule);
  }
  channelId() { return this.data.channelId || this.config.channelId; }
  setChannel(id) {
    if (!/^\d{1,30}$/.test(id)) throw new Error('Choose a posting channel');
    const next = { ...this.data, channelId: id };
    writePrivateJson(this.file, next); this.data = next;
  }
  mention(type) { return this.data.mentions[type] || { kind: 'none' }; }
  setMention(type, rule) {
    const next = { ...this.data, mentions: { ...this.data.mentions, [type]: validateMention(type, rule) } };
    writePrivateJson(this.file, next); this.data = next;
  }
  describe(type) {
    const rule = this.mention(type);
    return type + ': ' + (rule.kind === 'role' ? rule.roleIds.map(id => '<@&' + id + '>').join(' ') : rule.kind === 'everyone' ? '@everyone' : 'no ping');
  }
  decorate(type, payload, notify = true) {
    const rule = this.mention(type);
    const marker = rule.kind === 'role' ? rule.roleIds.map(id => '<@&' + id + '>').join(' ') : rule.kind === 'everyone' ? '@everyone' : '';
    const content = (marker && !payload.content.includes(marker) ? marker + '\n' : '') + payload.content;
    const allowed = !notify || rule.kind === 'none' ? { parse: [], users: [], roles: [] }
      : rule.kind === 'role' ? { parse: [], users: [], roles: rule.roleIds } : { parse: ['everyone'], users: [], roles: [] };
    return { ...payload, content: content.slice(0, 1950), allowed_mentions: allowed };
  }
}
module.exports = { OperatorSettings, validateMention };
