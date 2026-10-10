const crypto = require('node:crypto');
const { BASE_URL } = require('./config');

function clean(value) { return String(value ?? '').replace(/[@\r\n*_`~|<>\[\]\\]/g, ' ').trim().slice(0, 160); }
function format(value) { return BigInt(value).toLocaleString('en-US'); }
function eventToken(event) { return crypto.createHash('sha256').update(event.id).digest('hex').slice(0, 24); }
function alertPayload(event) {
  const reason = [event.countTriggered ? event.count + ' distinct monsters exceeded X (limit: ' + event.occurrences + ')' : '',
    event.upperTriggered ? 'Immediate limit H reached on a monster' : ''].filter(Boolean).join('\n');
  return { content: event.roleId ? '<@&' + event.roleId + '>' : '',
    embeds: [{ title: 'Damage Watch • ' + (clean(event.playerName) || 'Game player') + ' (#' + event.playerId + ')', color: event.upperTriggered ? 0xed4245 : 0xfee75c,
      description: '**Rule:** ' + clean(event.ruleName) + '\n' + reason,
      fields: [{ name: 'Dungeon', value: clean(event.name) + ' · #' + event.instanceId, inline: true },
        { name: 'Monster', value: clean(event.monsterName) + '\nBattle #' + new URL(event.url, BASE_URL).searchParams.get('dgmid'), inline: true },
        { name: 'Limits', value: 'X: ' + format(event.threshold) + ' damage · Y: ' + event.occurrences + (event.upper !== null ? '\nH: ' + format(event.upper) : '') }],
      footer: { text: 'Alert ' + eventToken(event) + ' • cumulative damage' }, timestamp: new Date(event.observedAt).toISOString() }],
    components: [{ type: 1, components: [
      { type: 2, style: 2, label: 'View evidence', custom_id: 'dw:evidence:' + eventToken(event) + ':0' },
      { type: 2, style: 5, label: 'Open monster', url: new URL(event.url, BASE_URL).toString() },
    ] }], allowed_mentions: { parse: [], users: [], roles: event.roleId ? [event.roleId] : [] } };
}
function evidencePayload(event, page = 0) {
  const count = event.evidence.length, last = Math.max(0, Math.ceil(count / 5) - 1);
  page = Math.max(0, Math.min(last, page));
  const lines = event.evidence.slice(page * 5, page * 5 + 5).map(row => '[Monster #' + row.monsterId + '](' + new URL(row.url, BASE_URL).toString() + ') — **' + format(row.damage) + '** damage');
  return { content: '**' + clean(event.playerName) + '** · Game ID ' + event.playerId + '\n' + clean(event.name) + ' #' + event.instanceId
      + '\nEvidence recorded when the alert triggered:\n' + lines.join('\n') + '\nPage ' + (page + 1) + '/' + (last + 1)
      + (event.count > count ? '\nEvidence display is capped at 100 monsters; the qualifying count is ' + event.count + '.' : ''),
    embeds: [], components: last ? [{ type: 1, components: [
      { type: 2, style: 2, label: 'Previous', custom_id: 'dw:evidence:' + eventToken(event) + ':' + Math.max(0, page - 1), disabled: page === 0 },
      { type: 2, style: 2, label: 'Next', custom_id: 'dw:evidence:' + eventToken(event) + ':' + Math.min(last, page + 1), disabled: page === last },
    ] }] : [], allowedMentions: { parse: [], users: [], roles: [] } };
}
module.exports = { clean, format, eventToken, alertPayload, evidencePayload };
