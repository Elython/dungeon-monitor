const fs = require('node:fs');
const path = require('node:path');

const BASE_URL = 'https://demonicscans.org';
function bounded(value, fallback, min, max) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw new Error('A numeric setting is outside its allowed range');
  return number;
}
function loadConfig(file) {
  const input = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const base = path.dirname(path.resolve(file));
  for (const key of ['applicationId', 'guildId', 'channelId']) {
    if (input.discord?.[key] !== undefined && typeof input.discord[key] !== 'string') throw new Error('Discord IDs must be quoted strings in config.json');
  }
  const operatorRoleIds = input.discord?.operatorRoleIds ?? [];
  const watcherReadBudget = bounded(input.watcherReadBudget, 6, 3, 30);
  if (!Number.isInteger(watcherReadBudget)) throw new Error('Watcher read budget must be a whole number');
  if (!Array.isArray(operatorRoleIds) || operatorRoleIds.some(id => typeof id !== 'string' || !/^\d{1,30}$/.test(id))) {
    throw new Error('Discord operatorRoleIds must be an array of quoted role IDs');
  }
  return {
    pollSeconds: bounded(input.pollSeconds, 120, 30, 3600),
    requestTimeoutSeconds: bounded(input.requestTimeoutSeconds, 20, 5, 120),
    requestGapMilliseconds: bounded(input.requestGapMilliseconds, 500, 100, 10000),
    missingConfirmations: bounded(input.missingConfirmations, 2, 2, 10),
    watcherReadBudget,
    watcherReadGapMilliseconds: bounded(input.watcherReadGapMilliseconds, 2000, 0, 10000),
    sessionFile: path.resolve(base, input.sessionFile || 'private/session.json'),
    stateFile: path.resolve(base, input.stateFile || 'data/state.json'),
    discord: {
      applicationId: String(input.discord?.applicationId || ''),
      guildId: String(input.discord?.guildId || ''),
      channelId: String(input.discord?.channelId || ''),
      operatorRoleIds: [...new Set(operatorRoleIds)],
      tokenFile: path.resolve(base, input.discord?.tokenFile || 'private/discord-bot-token.txt'),
      templatesFile: path.resolve(base, input.discord?.templatesFile || 'data/message-templates.json'),
      settingsFile: path.resolve(base, input.discord?.settingsFile || 'data/discord-settings.json'),
      watcherFile: path.resolve(base, input.discord?.watcherFile || 'data/watcher-settings.json'),
      dashboard: input.discord?.dashboard !== false,
      announcements: input.discord?.announcements !== false,
    },
  };
}
module.exports = { BASE_URL, loadConfig };
