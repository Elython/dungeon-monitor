const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('./config');
const { Session, importSession } = require('./session');
const { StateStore, writePrivateJson } = require('./storage');
const { GameReader } = require('./transport');
const { DungeonScanner } = require('./scanner');
const { DiscordPublisher } = require('./discord');
const { Monitor } = require('./monitor');
const { TemplateStore } = require('./templates');
const { OperatorSettings } = require('./operatorSettings');
const { BotRuntime, registerCommands, botToken, requireBotConfig, inviteLink } = require('./bot');
const { WatcherStore } = require('./watcherStore');
const { DamageWatcher } = require('./damageWatcher');

const root = path.resolve(__dirname, '..');
function option(args, key) { const index = args.indexOf(key); return index < 0 ? null : args[index + 1]; }
function acquireLock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (fs.existsSync(file)) {
    let pid; try { pid = JSON.parse(fs.readFileSync(file, 'utf8')).pid; } catch { throw new Error('Monitor lock is invalid; inspect it before removing it'); }
    if (!Number.isInteger(pid) || pid < 1) throw new Error('Monitor lock is invalid; inspect it before removing it');
    try { process.kill(pid, 0); throw new Error('Another monitor process is already running'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    fs.unlinkSync(file);
  }
  const descriptor = fs.openSync(file, 'wx', 0o600); fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid })); fs.closeSync(descriptor);
  return () => { if (fs.existsSync(file)) fs.unlinkSync(file); };
}
async function main(args = process.argv.slice(2)) {
  const command = args[0] || 'help';
  const configFile = path.resolve(option(args, '--config') || path.join(root, 'config.json'));
  if (command === 'init') {
    if (fs.existsSync(configFile)) throw new Error('Configuration already exists; it was preserved');
    writePrivateJson(configFile, JSON.parse(fs.readFileSync(path.join(root, 'config.example.json'), 'utf8')));
    console.log('Created local configuration. Fill the Discord bot IDs and private token before starting.'); return;
  }
  if (command === 'help') {
    console.log('Commands: init, import-session <Firefox HAR or cookie JSON>, check, invite-link, register-commands, run [--preview] [--once], notifications, resolve <event-id> <delivered|retry>, reset-dashboard\nAll commands accept --config <path>. Session imports may use --user-agent <browser user agent>.'); return;
  }
  const config = loadConfig(configFile);
  if (command === 'invite-link') { console.log(inviteLink(config.discord)); return; }
  if (command === 'register-commands') {
    await registerCommands(config.discord);
    console.log('Registered Dungeon Watch slash commands in the configured Discord server.'); return;
  }
  if (command === 'import-session') {
    if (!args[1] || args[1].startsWith('--')) throw new Error('Provide the local HAR or cookie-export file path');
    const release = acquireLock(config.stateFile + '.lock');
    try {
      importSession(path.resolve(args[1]), config.sessionFile, option(args, '--user-agent') || '');
      console.log('Monitoring session imported privately. Run npm run check to verify it.');
    } finally { release(); }
    return;
  }
  if (['notifications', 'resolve', 'reset-dashboard'].includes(command)) {
    const release = acquireLock(config.stateFile + '.lock');
    try {
      const store = new StateStore(config.stateFile);
      if (command === 'notifications') {
        console.log(JSON.stringify(Object.values(store.state.outbox).filter(row => ['uncertain', 'failed', 'queued'].includes(row.status)), null, 2));
        console.log('Dashboard: ' + (store.state.dashboard.uncertain ? 'unconfirmed' : store.state.dashboard.failed ? 'rejected' : 'ready'));
      } else if (command === 'resolve') {
        const event = store.state.outbox[args[1]];
        if (!event || !['delivered', 'retry'].includes(args[2])) throw new Error('Choose a listed event and delivered or retry after checking Discord');
        event.status = args[2] === 'retry' ? 'queued' : 'delivered'; delete event.retryAt; store.save();
        console.log('Notification resolution saved.');
      } else { store.state.dashboard = {}; store.save(); console.log('Dashboard reset. Check Discord for an existing unconfirmed post before running again.'); }
    } finally { release(); }
    return;
  }
  if (!['check', 'run'].includes(command)) throw new Error('Unknown command; run node src/cli.js help');
  const session = new Session(config.sessionFile);
  const scanner = new DungeonScanner(new GameReader(session, config), session);
  const controller = new AbortController();
  const stop = () => controller.abort(); process.once('SIGINT', stop); process.once('SIGTERM', stop);
  if (command === 'check') {
    const snapshot = await scanner.scan(controller.signal);
    console.log(JSON.stringify({ active: snapshot.instances.filter(row => row.active), warnings: snapshot.warnings }, null, 2));
    return;
  }
  const release = acquireLock(config.stateFile + '.lock');
  let bot = null;
  try {
    const store = new StateStore(config.stateFile);
    if (args.includes('--preview')) { store.state = structuredClone(store.state); store.save = () => {}; }
    const botEnabled = !args.includes('--preview');
    if (botEnabled) requireBotConfig(config.discord);
    const templates = new TemplateStore(config.discord.templatesFile, 'bot:' + config.discord.applicationId + ':' + config.discord.guildId);
    const settings = new OperatorSettings(config.discord.settingsFile, config.discord);
    const publisher = new DiscordPublisher(config.discord, store, { preview: args.includes('--preview'), templates, settings,
      token: botEnabled ? botToken(config.discord) : null });
    const monitor = new Monitor(scanner, store, publisher, config);
    const watcherSettings = new WatcherStore(config.discord.watcherFile, 'bot:' + config.discord.applicationId + ':' + config.discord.guildId);
    monitor.watcher = new DamageWatcher(scanner, store, watcherSettings, config);
    publisher.watcherSettings = watcherSettings;
    if (botEnabled) {
      bot = new BotRuntime(config.discord, { monitor, publisher, templates, settings, signal: controller.signal });
      await bot.connect();
    }
    await monitor.run(controller.signal, args.includes('--once'));
  } catch (error) { if (!controller.signal.aborted) throw error; }
  finally { bot?.destroy(); release(); }
}
if (require.main === module) main().catch(error => {
  console.error(error instanceof SyntaxError ? 'A local JSON file is invalid. Inspect the configuration, session or state file.' : error.message);
  process.exitCode = 1;
});
module.exports = { main, acquireLock };
