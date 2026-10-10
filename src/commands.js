const { validateMention } = require('./operatorSettings');
const TYPES = ['opened', 'closed', 'boss_opened', 'dashboard'];
const TYPE_LABELS = { opened: 'Dungeon opens', closed: 'Dungeon closes', boss_opened: 'Boss room opens', dashboard: 'Live dungeon list' };
const typeOption = () => ({ type: 3, name: 'type', description: 'Message type', required: true, choices: TYPES.map(value => ({ name: TYPE_LABELS[value], value })) });
const COMMANDS = [
  { name: 'ping', description: 'Check whether Dungeon Watch is online' },
  { name: 'status', description: 'Show current dungeons and monitor health without a game request' },
  { name: 'refresh', description: 'Run a game scan and update the monitor', default_member_permissions: '32' },
  { name: 'test', description: 'Send an example privately, or explicitly test in the announcement channel', default_member_permissions: '32', options: [typeOption(), { type: 3, name: 'destination', description: 'Where to send the test (default: direct message)', required: false, choices: [{ name: 'Direct message', value: 'private' }, { name: 'Announcement channel', value: 'channel' }] }, { type: 5, name: 'ping', description: 'Use the configured ping for this test (normally off)', required: false }] },
  { name: 'channel', description: 'Choose where Dungeon Watch posts', default_member_permissions: '32', options: [
    { type: 1, name: 'show', description: 'Show the current posting channel' },
    { type: 1, name: 'set', description: 'Change the posting channel and save it', options: [
      { type: 7, name: 'channel', description: 'Text or announcement channel in this server', required: true, channel_types: [0, 5] },
    ] },
  ] },
  { name: 'mentions', description: 'Choose who gets pinged for each message type', default_member_permissions: '32', options: [
    { type: 1, name: 'show', description: 'Show the current ping rules' },
    { type: 1, name: 'set', description: 'Set no ping, one or more roles, or everyone', options: [
      typeOption(), { type: 3, name: 'target', description: 'Who should be pinged?', required: true, choices: [
        { name: 'No ping', value: 'none' }, { name: 'Role', value: 'role' }, { name: 'Everyone', value: 'everyone' },
      ] }, { type: 8, name: 'role', description: 'Choose a role when target is Role', required: false },
      { type: 3, name: 'roles', description: 'Role mentions or IDs separated by spaces (up to 25 roles total)', required: false, max_length: 1000 },
    ] },
    { type: 1, name: 'reset', description: 'Turn pings off for one message type', options: [typeOption()] },
  ] },
  { name: 'messages', description: 'Customize Dungeon Watch message formats', default_member_permissions: '32', options: [
    { type: 1, name: 'show', description: 'Show the current message template', options: [typeOption()] },
    { type: 1, name: 'preview', description: 'Preview a message privately without posting it', options: [typeOption()] },
    { type: 1, name: 'set', description: 'Save a message template; use \\n for line breaks', options: [typeOption(), { type: 3, name: 'text', description: 'Template text with placeholders, e.g. {name} and {url}', required: true, max_length: 1500 }] },
    { type: 1, name: 'reset', description: 'Restore the default format for one message type', options: [typeOption()] },
  ] },
  { name: 'watcher', description: 'Open the interactive dungeon damage watcher panel', default_member_permissions: '32' },
];

class CommandHandler {
  constructor({ config, monitor, publisher, templates, settings, validateChannel, validateMention: verifyMention, signal, now = () => Date.now() }) {
    Object.assign(this, { config, monitor, publisher, templates, settings, validateChannel, verifyMention, signal, now }); this.lastRefreshAt = 0;
  }
  async handle(interaction) {
    if (!interaction.isChatInputCommand()) return;
    if (!COMMANDS.some(command => command.name === interaction.commandName)) return;
    if (interaction.guildId !== this.config.guildId) {
      await interaction.reply({ content: 'This monitor is configured for another server.', flags: 64, allowedMentions: { parse: [] } }); return;
    }
    const roles = interaction.member?.roles;
    const isOperator = (this.config.operatorRoleIds || []).some(id => Array.isArray(roles) ? roles.includes(id) : roles?.cache?.has(id));
    if (['refresh', 'test', 'messages', 'channel', 'mentions', 'watcher'].includes(interaction.commandName) && !interaction.memberPermissions?.has(32n) && !isOperator) {
      await interaction.reply({ content: 'You need a configured bot operator role or Manage Server permission to use this command.', flags: 64, allowedMentions: { parse: [] } }); return;
    }
    await interaction.deferReply({ flags: 64 });
    const preview = type => {
      const payload = this.templates.preview(type, this.now());
      return this.settings ? this.settings.decorate(type, payload, false).content : payload.content;
    };
    const reply = content => interaction.editReply({ content: String(content).slice(0, 2000), allowedMentions: { parse: [] } });
    try {
      if (interaction.commandName === 'watcher') return reply('The damage watcher is unavailable. Contact the host to check the watcher configuration.');
      if (interaction.commandName === 'ping') return reply('Pong! Dungeon Watch is online.');
      if (interaction.commandName === 'status') {
        const state = this.monitor.store.state;
        const queued = Object.values(state.outbox).filter(event => event.status === 'queued').length;
        const uncertain = Object.values(state.outbox).filter(event => event.status === 'uncertain').length;
        return reply(this.templates.dashboard(state).content + '\n\nPending announcements: ' + queued + ' · Unconfirmed: ' + uncertain);
      }
      if (interaction.commandName === 'refresh') {
        if (this.lastRefreshAt && this.now() - this.lastRefreshAt < 60000) return reply('Please wait one minute between manual refreshes.');
        this.lastRefreshAt = this.now();
        await this.monitor.cycle(this.signal);
        return reply('Refresh finished.\n' + this.templates.dashboard(this.monitor.store.state).content);
      }
      if (interaction.commandName === 'channel') {
        if (interaction.options.getSubcommand() === 'show') return reply('Posting channel: <#' + this.publisher.channelId() + '>');
        const channel = interaction.options.getChannel('channel', true);
        await this.validateChannel(channel.id);
        for (const type of TYPES) await this.verifyMention(this.settings.mention(type), channel.id);
        await this.publisher.changeChannel(channel.id);
        await this.publisher.publish(this.signal, { dashboardOnly: true });
        return reply('Now posting in <#' + channel.id + '>. This choice is saved for restarts. The old live-list message remains in its previous channel.');
      }
      if (interaction.commandName === 'mentions') {
        const action = interaction.options.getSubcommand();
        if (action === 'show') return reply(TYPES.map(type => this.settings.describe(type)).join('\n'));
        const type = interaction.options.getString('type', true);
        const kind = action === 'reset' ? 'none' : interaction.options.getString('target', true);
        const selected = interaction.options.getRole?.('role')?.id;
        const extra = kind === 'role' ? (interaction.options.getString('roles') || '').trim() : '';
        const roleIds = selected ? [selected] : [];
        for (const token of extra ? extra.split(/[\s,]+/) : []) {
          const match = /^(?:<@&(\d{1,30})>|(\d{1,30}))$/.exec(token);
          if (!match) throw new Error('Choose roles using @role mentions or role IDs separated by spaces');
          roleIds.push(match[1] || match[2]);
        }
        const rule = validateMention(type, { kind, roleIds });
        await this.verifyMention(rule);
        await this.publisher.changeMention(type, rule);
        if (type === 'dashboard') await this.publisher.publish(this.signal, { dashboardOnly: true });
        return reply('Saved ping rule: ' + this.settings.describe(type) + '. Test posts stay silent unless ping is enabled for the test.');
      }
      const type = interaction.options.getString('type', true);
      if (interaction.commandName === 'test') {
        const ping = interaction.options.getBoolean?.('ping') === true;
        const destination = interaction.options.getString('destination') || 'private';
        if (destination !== 'channel') {
          if (ping) return reply('To test a ping, choose destination:channel. Direct-message tests never ping recipients.');
          try {
            await interaction.user.send({ content: '[TEST — not a real dungeon event]\n' + preview(type).slice(0, 1900), allowedMentions: { parse: [], users: [], roles: [] } });
          } catch {
            return reply('Discord could not confirm the direct message. Check your DMs before retrying. Allow direct messages from this server, or use /messages preview for a private reply here.');
          }
          return reply('Test message sent to your direct messages.');
        }
        if (ping) await this.verifyMention(this.settings.mention(type));
        const result = await this.publisher.sendTest(type, this.signal, { ping });
        return reply(result.status === 'delivered' ? 'Test message posted to the configured channel.'
          : result.status === 'rate_limited' ? 'Discord rate-limited the test. No automatic test retry was scheduled.' : result.error || 'Discord could not confirm the test message. Check the channel before retrying.');
      }
      const action = interaction.options.getSubcommand();
      if (action === 'show') return reply('Current ' + type + ' template:\n' + this.templates.get(type).replaceAll('\n', '\\n') + '\n\nTemplate changes affect future announcements. The live dashboard is updated immediately.');
      if (action === 'preview') return reply('[PRIVATE PREVIEW — not a real event]\n' + preview(type));
      if (action === 'set') this.templates.set(type, interaction.options.getString('text', true));
      else if (action === 'reset') this.templates.reset(type);
      else return reply('Unknown template action.');
      if (type === 'dashboard') await this.publisher.publish(this.signal, { dashboardOnly: true });
      return reply('Saved the ' + type + ' format. Previous announcements remain as history.\n\n[PRIVATE PREVIEW]\n' + preview(type));
    } catch (error) {
      return reply(/^(Choose|The bot needs|Make that role|Unknown message type|Unsupported placeholder|Message template)/.test(error.message || '')
        ? error.message : 'The command could not finish. Check the selected channel or role, and contact the host if it keeps failing.');
    }
  }
}
module.exports = { COMMANDS, CommandHandler, TYPES };
