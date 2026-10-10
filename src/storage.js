const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function writePrivateJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.tmp-' + crypto.randomUUID();
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}
function emptyState() {
  return { version: 1, owner: null, initialized: false, instances: {}, outbox: {}, dashboard: {}, health: null, lastScanAt: null,
    watcher: { monsters: {}, players: {}, alerted: {}, health: null, lastScanAt: null } };
}
class StateStore {
  constructor(file) {
    this.file = file;
    this.state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : emptyState();
    if (this.state.version !== 1 || !this.state.instances || !this.state.outbox || !this.state.dashboard) throw new Error('Monitor state format is invalid; preserve the file for inspection');
    this.state.watcher ||= emptyState().watcher;
    if (!this.state.watcher.monsters || !this.state.watcher.players || !this.state.watcher.alerted) throw new Error('Watcher runtime state is invalid; preserve the file for inspection');
    for (const event of Object.values(this.state.outbox)) if (event.status === 'sending') event.status = 'uncertain';
    if (this.state.dashboard.sending) { this.state.dashboard.uncertain = true; delete this.state.dashboard.sending; }
  }
  save() { writePrivateJson(this.file, this.state); }
}
module.exports = { writePrivateJson, StateStore, emptyState };
