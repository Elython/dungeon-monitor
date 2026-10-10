const { BASE_URL } = require('./config');
function text(value) { return String(value || '').replace(/[\r\n]/g, ' ').replace(/[\\*_`~|<>\[\]]/g, '').slice(0, 160); }
function link(value) { const url = new URL(value, BASE_URL); return url.origin === BASE_URL ? url.toString() : BASE_URL; }
function announcement(event) {
  const label = event.type === 'opened' ? 'Dungeon opened' : event.type === 'closed' ? 'Dungeon closed' : 'Boss room opened';
  const room = event.roomName ? ' — ' + text(event.roomName) : '';
  return { content: '**' + label + ': ' + text(event.name) + room + '**\nInstance #' + event.instanceId
    + (event.detail ? ' · ' + text(event.detail) : '') + '\n' + link(event.url)
    + '\nDetected <t:' + Math.floor(event.observedAt / 1000) + ':f>', allowed_mentions: { parse: [] } };
}
function dashboard(state) {
  const lines = ['**Active dungeons**'];
  if (state.health?.status === 'error') lines.push('Monitoring unavailable: ' + text(state.health.detail) + '. Showing the last verified state.');
  const active = Object.values(state.instances).filter(row => row.active).sort((a, b) => a.name.localeCompare(b.name));
  if (!active.length) lines.push(state.initialized ? 'No active dungeons were found in the last successful scan.' : 'Waiting for the first successful scan.');
  for (const instance of active) {
    lines.push('\n**' + text(instance.name) + '** · #' + instance.instanceId + (instance.missingScans ? ' · awaiting closure confirmation' : ''));
    lines.push(link(instance.url));
    const rooms = Object.values(instance.rooms || {});
    if (!rooms.length) lines.push('Boss room: unknown — page capture may be needed');
    for (const room of rooms) lines.push(text(room.name) + ': ' + room.status);
  }
  if (state.health?.status === 'partial') lines.push('\nSome room information is unavailable: ' + text(state.health.detail));
  if (state.lastScanAt) lines.push('\nLast successful scan: <t:' + Math.floor(state.lastScanAt / 1000) + ':f>');
  return { content: lines.join('\n').slice(0, 1950), allowed_mentions: { parse: [] } };
}
module.exports = { announcement, dashboard };
