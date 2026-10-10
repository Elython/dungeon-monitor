const fs = require('node:fs');
const { COMMANDS, CommandHandler } = require('./commands');
const { WatcherPanel } = require('./watcherPanel');

function sdk() {
  try { return require('discord.js'); }
  catch { throw new Error('Discord bot mode needs its library. Run npm install in dungeon-monitor first.'); }
}
function botToken(config, env = process.env) {
  const value = env.DISCORD_BOT_TOKEN || (fs.existsSync(config.tokenFile) ? fs.readFileSync(config.tokenFile, 'utf8').trim() : '');
  if (!value || /\s/.test(value)) throw new Error('Save the Discord bot token in its private token file or DISCORD_BOT_TOKEN environment variable');
  return value;
}
function requireBotConfig(config) {
  if (![config.applicationId, config.guildId, config.channelId].every(id => /^\d{1,30}$/.test(id || ''))) {
    throw new Error('Configure Discord Application ID, Server ID and Channel ID first');
  }
}
function inviteLink(config) {
  requireBotConfig(config);
  const url = new URL('https://discord.com/oauth2/authorize');
  url.searchParams.set('client_id', config.applicationId);
  url.searchParams.set('scope', 'bot applications.commands');
  url.searchParams.set('permissions', '84992');
  url.searchParams.set('guild_id', config.guildId);
  url.searchParams.set('disable_guild_select', 'true');
  return url.toString();
}

async function registerCommands(config, { sdkProvider = sdk, env = process.env } = {}) {
  requireBotConfig(config);
  const { REST, Routes } = sdkProvider();
  const rest = new REST({ version: '10', retries: 0 }).setToken(botToken(config, env));
  try {
    // Each command is upserted by name; unrelated commands on this application are preserved.
    for (const command of COMMANDS) await rest.post(Routes.applicationGuildCommands(config.applicationId, config.guildId), { body: config.operatorRoleIds?.length && command.default_member_permissions
      ? { ...command, default_member_permissions: null } : command });
  } catch { throw new Error('Command registration failed. Check the token, IDs and that the bot was invited with applications.commands.'); }
}
class BotRuntime {
  constructor(config, { monitor, publisher, templates, settings, signal, log = console.log }) {
    this.config = config; this.log = log; this.publisher = publisher; this.settings = settings;
    this.handler = new CommandHandler({ config, monitor, publisher, templates, settings, signal,
      validateChannel: id => this.validateChannel(id), validateMention: (rule, id) => this.validateMention(rule, id) });
    if (monitor.watcher) this.watcherPanel = new WatcherPanel({ config, monitor, watcher: monitor.watcher, settings: monitor.watcher.settings, signal, log,
      validateChannel: id => this.validateChannel(id, { embeds: true }), validateMention: (rule, id) => this.validateMention(rule, id) });
  }
  async connect() {
    requireBotConfig(this.config);
    const { Client, Events, GatewayIntentBits } = sdk();
    this.client = new Client({ intents: [GatewayIntentBits.Guilds], rest: { retries: 0, timeout: 20000 } });
    this.client.on(Events.Error, () => this.log('Discord connection reported an error. Check network connectivity.'));
    this.client.on(Events.InteractionCreate, interaction => {
      this.handleInteraction(interaction).catch(() => this.log('A Discord command reply could not be confirmed.'));
    });
    try {
      await this.client.login(botToken(this.config));
      if (!this.client.isReady()) await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Discord ready timed out')), 30000);
        this.client.once(Events.ClientReady, () => { clearTimeout(timer); resolve(); });
      });
      if (this.client.application.id !== this.config.applicationId) throw new Error('Bot token belongs to a different application');
      await this.validateChannel(this.publisher.channelId());
      this.log('Discord bot connected. Slash commands are available in the configured server.');
    } catch {
      this.destroy(); throw new Error('Discord bot startup failed. Check the token, application/server/channel IDs, invitation and channel permissions.');
    }
  }
  async handleInteraction(interaction) {
    if (this.watcherPanel && await this.watcherPanel.handle(interaction)) return;
    await this.handler.handle(interaction);
  }
  async validateChannel(id, { embeds = false } = {}) {
    const channel = await this.client.channels.fetch(id);
    if (!channel || ![0, 5].includes(channel.type) || channel.guildId !== this.config.guildId) throw new Error('Choose a text or announcement channel in this server');
    const permissions = channel.permissionsFor(this.client.user);
    if (![1024n, 2048n, 65536n].every(bit => permissions?.has(bit))) throw new Error('The bot needs View Channel, Send Messages and Read Message History in that channel');
    if (embeds && !permissions?.has(16384n)) throw new Error('The bot needs Embed Links permission in the watcher notification channel');
    return channel;
  }
  async validateMention(rule, channelId = this.publisher.channelId()) {
    if (rule.kind === 'none') return;
    const channel = await this.validateChannel(channelId);
    const canMention = channel.permissionsFor(this.client.user)?.has(131072n);
    if (rule.kind === 'everyone') {
      if (!canMention) throw new Error('The bot needs Mention @everyone, @here and All Roles permission in the posting channel');
      return;
    }
    for (const roleId of rule.roleIds || [rule.roleId]) {
      const role = await channel.guild.roles.fetch(roleId);
      if (!role || role.id === this.config.guildId) throw new Error('Choose a role in this server; use everyone for the everyone role');
      if (!role.mentionable && !canMention) throw new Error('Make that role mentionable, or give the bot Mention @everyone, @here and All Roles permission');
    }
  }
  destroy() { this.client?.destroy(); }
}
module.exports = { BotRuntime, registerCommands, botToken, requireBotConfig, inviteLink };
