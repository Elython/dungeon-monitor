const crypto = require('node:crypto');
const { runtime, evidence, sameName } = require('./damageWatcher');
const { clean, format, eventToken, evidencePayload } = require('./watcherMessages');

const row = (...components) => ({ type: 1, components });
const button = (label, custom_id, style = 2, disabled = false) => ({ type: 2, label, custom_id, style, disabled });
const select = (custom_id, placeholder, options) => row({ type: 3, custom_id, placeholder, min_values: 1, max_values: 1, options });
const token = name => crypto.createHash('sha256').update(name).digest('hex').slice(0, 24);
function modal(custom_id, title, fields) {
  return { custom_id, title, components: fields.map(([id, label, value, required = true]) => ({
    type: 18, label, component: { type: 4, custom_id: id, style: id === 'ids' ? 2 : 1, value: String(value || ''), required,
      max_length: id === 'ids' ? 4000 : id === 'name' ? 160 : 60 },
  })) };
}
function controlFailure(error, action) {
  const issues = [];
  const visit = (node, path = '', depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 8 || issues.length >= 8) return;
    for (const entry of node._errors || []) issues.push(path + ':' + String(entry.code || 'invalid').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60));
    for (const [key, value] of Object.entries(node)) if (key !== '_errors') visit(value, (path ? path + '.' : '') + key.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 50), depth + 1);
  };
  visit(error.rawError?.errors);
  return 'Watcher interface error: action=' + action + ' code=' + String(error.code || error.name || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60)
    + (issues.length ? ' fields=' + issues.join(', ').slice(0, 700) : '');
}
class WatcherPanel {
  constructor({ config, monitor, watcher, settings, validateChannel, validateMention, signal, now = () => Date.now(), log = () => {} }) {
    Object.assign(this, { config, monitor, watcher, settings, validateChannel, validateMention, signal, now, log }); this.lastRefreshAt = 0;
  }
  active() { return Object.values(this.monitor.store.state.instances).filter(instance => instance.active); }
  operator(interaction) {
    const roles = interaction.member?.roles;
    return interaction.memberPermissions?.has(32n) || (this.config.operatorRoleIds || []).some(id => Array.isArray(roles) ? roles.includes(id) : roles?.cache?.has(id));
  }
  id(action, rule, suffix = '') { return 'dw:' + action + ':' + rule.id + ':' + rule.revision + (suffix ? ':' + suffix : ''); }
  choices(rule) {
    const active = new Set(this.active().filter(instance => sameName(instance.name, rule.dungeonName)).map(instance => instance.instanceId));
    return [...new Set(Object.values(runtime(this.monitor.store.state).monsters).filter(monster => active.has(monster.instanceId)).map(monster => monster.name))].sort();
  }
  ruleSelect(selectedId = null) {
    const rules = this.settings.rules();
    return rules.length ? select('dw:select', 'Select a saved watcher rule', rules.map(rule => ({ label: rule.name.slice(0, 100), value: rule.id,
      description: (rule.enabled ? 'Enabled • ' : 'Paused • ') + rule.monsterName.slice(0, 85), default: rule.id === selectedId }))) : null;
  }
  home(note = '') {
    const data = runtime(this.monitor.store.state);
    const components = [this.ruleSelect(), row(button('Add rule', 'dw:new', 1),
      ...(this.creationTargets().length > 25 ? [button('Other monster pages', 'dw:newPages')] : []),
      button('Ignored players', 'dw:ignore'), button('Refresh discovery', 'dw:refresh'))].filter(Boolean);
    return { content: note, embeds: [{ title: 'Damage Watcher', color: 0x5865f2,
      description: 'Count each player once per monster above X. Alert at Y monsters, or immediately at H. New dungeon instances start fresh.\n\nSelect a rule below or add your first one.',
      fields: [{ name: 'Status', value: clean(data.health?.detail || data.health?.status || 'Waiting for discovery') || 'Ready' },
        { name: 'Visibility', value: 'Only leaderboard rows exposed by the server can be observed. Scans are periodic, not live.' },
        { name: 'Ignored game IDs', value: String(this.settings.data.ignoredPlayerIds.length) } ],
      footer: { text: data.lastScanAt ? 'Last watcher scan: ' + new Date(data.lastScanAt).toISOString() : 'Run /refresh if no active dungeons are listed' } }],
      components, allowedMentions: { parse: [], users: [], roles: [] } };
  }
  panel(rule, page = null, note = '') {
    const names = this.choices(rule), last = Math.max(0, Math.ceil(names.length / 23) - 1);
    if (page === null) page = Math.max(0, Math.floor(names.indexOf(rule.monsterName) / 23));
    page = Math.max(0, Math.min(last, Number(page) || 0));
    const options = names.slice(page * 23, page * 23 + 23).map(name => ({ label: name.slice(0, 100), value: token(name), default: name === rule.monsterName }));
    if (page > 0) options.push({ label: 'Previous monsters', value: 'page:' + (page - 1) });
    if (page < last) options.push({ label: 'More monsters', value: 'page:' + (page + 1) });
    const dungeons = [...new Map(this.active().map(instance => [instance.name, instance])).values()].slice(0, 25);
    const components = [this.ruleSelect(rule.id)];
    if (dungeons.length) components.push(select(this.id('dungeon', rule), 'Dungeon: ' + rule.dungeonName.slice(0, 80),
      dungeons.map(instance => ({ label: instance.name.slice(0, 100), value: instance.instanceId, default: sameName(instance.name, rule.dungeonName) }))));
    if (options.length) components.push(select(this.id('monster', rule), 'Monster: ' + rule.monsterName.slice(0, 80), options));
    components.push(row(button('Edit limits', this.id('limits', rule)), button(rule.enabled ? 'Pause' : 'Enable', this.id('toggle', rule), rule.enabled ? 2 : 3),
      button('Preview / counts', this.id('counts', rule)), button('Delete', this.id('delete', rule), 4)));
    components.push(row(button('Channel / ping', this.id('destination', rule)), button('Ignored players', 'dw:ignore'), button('Refresh', this.id('refreshRule', rule)), button('Back', 'dw:home')));
    const data = runtime(this.monitor.store.state);
    return { content: note, embeds: [{ title: clean(rule.name), color: rule.enabled ? 0x57f287 : 0x99aab5,
      description: '**' + (rule.enabled ? 'Enabled' : 'Paused') + '** • ' + clean(rule.dungeonName) + '\nMonster: **' + clean(rule.monsterName) + '**',
      fields: [{ name: 'X · damage above', value: format(rule.threshold), inline: true }, { name: 'Y · distinct monsters', value: String(rule.occurrences), inline: true },
        { name: 'H · immediate limit', value: rule.upper === null ? 'Off' : format(rule.upper), inline: true },
        { name: 'Notification channel', value: rule.channelId ? '<#' + rule.channelId + '>' : 'Choose Channel / ping before enabling', inline: true },
        { name: 'Role ping', value: rule.roleId ? '<@&' + rule.roleId + '>' : 'None', inline: true },
        { name: 'Watcher health', value: clean(data.health?.detail || data.health?.status || 'Waiting for scan') || 'Ready' }],
      footer: { text: 'Existing visible damage counts. Game player IDs identify exclusions. New instances reset counts.' } }], components: components.filter(Boolean),
      allowedMentions: { parse: [], users: [], roles: [] } };
  }
  destinations(rule) {
    return { content: '**' + clean(rule.name) + ' • notifications**\nChannel: ' + (rule.channelId ? '<#' + rule.channelId + '>' : 'Not selected')
      + '\nRole ping: ' + (rule.roleId ? '<@&' + rule.roleId + '>' : 'None') + '\nChanges save automatically. Your saved selections stay selected.', embeds: [],
      components: [row({ type: 8, custom_id: this.id('channel', rule), channel_types: [0, 5], placeholder: 'Notification channel', min_values: 1, max_values: 1,
        ...(rule.channelId ? { default_values: [{ id: rule.channelId, type: 'channel' }] } : {}) }),
        row({ type: 6, custom_id: this.id('role', rule), placeholder: 'Optional notification role', min_values: 0, max_values: 1,
          ...(rule.roleId ? { default_values: [{ id: rule.roleId, type: 'role' }] } : {}) }),
        row(button('Disable ping', this.id('noRole', rule)), button('Back', this.id('view', rule)))], allowedMentions: { parse: [] } };
  }
  counts(rule, page = 0) {
    const state = this.monitor.store.state, data = runtime(state), lines = [];
    for (const instance of this.active().filter(instance => sameName(instance.name, rule.dungeonName))) {
      for (const [playerId, player] of Object.entries(data.players)) {
        const rows = evidence(state, rule, instance.instanceId, playerId, this.settings.data.ignoredPlayerIds);
        if (rows.length) lines.push(clean(player.name).slice(0, 60) + ' (ID ' + playerId + ') — **' + rows.length + '/' + rule.occurrences + '** · dungeon #' + instance.instanceId);
      }
    }
    const last = Math.max(0, Math.ceil(lines.length / 8) - 1); page = Math.min(last, Math.max(0, Number(page) || 0));
    const preview = this.watcher.preview(rule);
    return { content: '**' + clean(rule.name) + ' • cached preview**\n' + (lines.slice(page * 8, page * 8 + 8).join('\n') || 'No qualifying damage has been observed yet.')
      + '\n\n' + preview.length + ' player alert(s) would trigger from currently cached data. Paused previews sample leaderboards without enabling notifications.'
      + '\nPage ' + (page + 1) + '/' + (last + 1) + '\nServer-visible rows only; this preview sends no alerts.',
      embeds: [], components: [row(button('Previous', this.id('counts', rule, String(Math.max(0, page - 1))), 2, page === 0),
        button('Next', this.id('counts', rule, String(Math.min(last, page + 1))), 2, page === last), button('Back', this.id('view', rule)))], allowedMentions: { parse: [] } };
  }
  async refresh() {
    if (this.lastRefreshAt && this.now() - this.lastRefreshAt < 60000) throw new Error('Choose refresh at most once per minute.');
    this.lastRefreshAt = this.now(); await this.monitor.cycle(this.signal);
  }
  requestCreationDiscovery() {
    for (const dungeon of this.active()) this.watcher.requestDiscovery(dungeon.instanceId);
  }
  creationTargets() {
    const active = new Map(this.active().map(instance => [instance.instanceId, instance]));
    const targets = new Map();
    for (const monster of Object.values(runtime(this.monitor.store.state).monsters)) {
      const dungeon = active.get(monster.instanceId);
      if (!dungeon || !monster.name) continue;
      const value = token(dungeon.instanceId + '\n' + monster.name);
      targets.set(value, { value, instanceId: dungeon.instanceId, dungeonName: dungeon.name, monsterName: monster.name });
    }
    return [...targets.values()].sort((a, b) => a.dungeonName.localeCompare(b.dungeonName) || a.monsterName.localeCompare(b.monsterName) || a.instanceId.localeCompare(b.instanceId));
  }
  creationForm(page = 0) {
    const all = this.creationTargets(), last = Math.max(0, Math.ceil(all.length / 25) - 1);
    page = Math.max(0, Math.min(last, Number(page) || 0));
    const targets = all.slice(page * 25, page * 25 + 25);
    if (!targets.length) throw new Error('Choose Refresh discovery first: no dungeon monsters have been discovered yet.');
    const dungeons = [...new Map(targets.map(target => [target.instanceId, target])).values()];
    const form = modal('dw:createForm', 'Create damage watcher', [['x', 'X · Damage must exceed this total', ''],
      ['y', 'Y · Number of distinct monsters', '1'], ['h', 'H · Immediate damage limit (optional)', '', false]]);
    form.components.unshift(
      { type: 18, label: 'Dungeon', description: 'Scanned dungeons on this monster page.',
        component: { type: 3, custom_id: 'dungeon', placeholder: 'Select the dungeon', min_values: 1, max_values: 1,
          options: dungeons.map(target => ({ label: target.dungeonName.slice(0, 100), description: 'Dungeon instance #' + target.instanceId, value: target.instanceId, default: dungeons.length === 1 })) } },
      { type: 18, label: 'Monster', description: 'Page ' + (page + 1) + '/' + (last + 1) + '. Choose a monster belonging to the selected dungeon.',
        component: { type: 3, custom_id: 'monster', placeholder: 'Select the monster; dungeon is listed underneath', min_values: 1, max_values: 1,
          options: targets.map(target => ({ label: target.monsterName.slice(0, 100), description: (target.dungeonName + ' · #' + target.instanceId).slice(0, 100), value: target.value })) } },
    );
    return form;
  }
  creationPages(group = 0) {
    const targets = this.creationTargets(), pages = Math.ceil(targets.length / 25);
    const lastGroup = Math.max(0, Math.ceil(pages / 25) - 1);
    group = Math.max(0, Math.min(lastGroup, Number(group) || 0));
    const options = Array.from({ length: Math.min(25, pages - group * 25) }, (_, index) => {
      const page = group * 25 + index, first = targets[page * 25], last = targets[Math.min(targets.length - 1, page * 25 + 24)];
      return { label: 'Monster page ' + (page + 1), value: String(page), description: (first.dungeonName + ' / ' + first.monsterName + ' … ' + last.monsterName).slice(0, 100) };
    });
    return { content: 'Choose a monster page to open a popup containing Dungeon, Monster, X, Y and H together. No targets or rules are selected or saved here.',
      embeds: [], components: [options.length ? select('dw:newPage', 'Open a creation popup for this monster page', options) : null,
        row(button('Previous pages', 'dw:newPages:' + Math.max(0, group - 1), 2, group === 0),
          button('Next pages', 'dw:newPages:' + Math.min(lastGroup, group + 1), 2, group === lastGroup), button('Back', 'dw:home'))].filter(Boolean),
      allowedMentions: { parse: [] } };
  }
  ignoredChoices() {
    const players = runtime(this.monitor.store.state).players;
    return [...new Set([...Object.keys(players), ...this.settings.data.ignoredPlayerIds])].sort((a, b) => String(players[a]?.name || a).localeCompare(String(players[b]?.name || b)));
  }
  ignored(page = 0, note = '', manualOnly = this.ignoreDropdownRejected === true) {
    const ids = manualOnly ? this.settings.data.ignoredPlayerIds : this.ignoredChoices();
    const pageSize = manualOnly ? 15 : 25, last = Math.max(0, Math.ceil(ids.length / pageSize) - 1);
    page = Math.min(last, Math.max(0, Number(page) || 0));
    const revision = this.settings.data.ignoredRevision;
    const options = ids.slice(page * pageSize, page * pageSize + pageSize).map(id => ({ label: (clean(runtime(this.monitor.store.state).players[id]?.name) || 'Game player #' + id).slice(0, 100),
      description: 'Game ID: ' + id, value: id, default: this.settings.data.ignoredPlayerIds.includes(id) }));
    return { content: (note ? note + '\n\n' : '') + '**Ignored game players • all watcher rules**\n'
      + (manualOnly ? 'Use Add game IDs or Remove game IDs. The dropdown is unavailable; exclusions still match game IDs.\n' : 'Choose the players to ignore on this page. Unselecting removes that exclusion. Names are labels only: matching uses the game ID.\n')
      + this.settings.data.ignoredPlayerIds.length + ' ignored ID(s) · Page ' + (page + 1) + '/' + (last + 1)
      + (manualOnly ? '\nSaved IDs on this page: ' + (ids.slice(page * pageSize, page * pageSize + pageSize).join(', ') || 'None') : ''), embeds: [],
      components: [options.length && !manualOnly ? row({ type: 3, custom_id: 'dw:ignoreSelect:' + revision + ':' + page + ':' + token(options.map(option => option.value).join(',')), placeholder: 'Ignored players on this page',
        options, min_values: 0, max_values: options.length }) : null,
        row(button('Add game IDs', 'dw:ignoreIds', 1), button('Remove game IDs', 'dw:removeIds'), button('Clear all', 'dw:clearIgnored', 4)),
        row(button('Previous', 'dw:ignorePage:' + Math.max(0, page - 1), 2, page === 0),
          button('Next', 'dw:ignorePage:' + Math.min(last, page + 1), 2, page === last), button('Back', 'dw:home'))].filter(Boolean),
      allowedMentions: { parse: [] } };
  }
  async handle(interaction) {
    const isSlash = interaction.isChatInputCommand?.() && interaction.commandName === 'watcher';
    if (!isSlash && !String(interaction.customId || '').startsWith('dw:')) return false;
    const replyError = message => interaction.reply({ content: message, flags: 64, allowedMentions: { parse: [] } });
    if (interaction.guildId !== this.config.guildId) { await replyError('This watcher belongs to another server.'); return true; }
    const parts = String(interaction.customId || '').split(':');
    const action = parts[1];
    if (action === 'evidence') {
      const event = Object.values(this.monitor.store.state.outbox).find(event => event.type === 'damage_watch' && eventToken(event) === parts[2]);
      if (!event) await replyError('This evidence record is no longer available.');
      else await interaction.reply({ ...evidencePayload(event, Number(parts[3]) || 0), flags: 64 });
      return true;
    }
    if (!this.operator(interaction)) { await replyError('You need a bot operator role or Manage Server permission to edit watchers.'); return true; }
    if (interaction.appPermissions && !interaction.appPermissions.has(16384n)) { await replyError('The bot needs Embed Links permission in this channel to show the watcher panel.'); return true; }
    let deferred = false;
    try {
      if (isSlash) { this.requestCreationDiscovery(); await interaction.reply(this.home()); return true; }
      if (action === 'new' || action === 'newPage') {
        if (!this.active().length) throw new Error('Choose /refresh first: no active dungeon has been verified.');
        this.requestCreationDiscovery();
        if (!this.creationTargets().length) {
          await interaction.update(this.home('Monster discovery is scheduled. Press Refresh discovery, then Add rule to open the five-field popup.')); return true;
        }
        await interaction.showModal(this.creationForm(action === 'newPage' ? interaction.values[0] : 0)); return true;
      }
      if (action === 'newPages') {
        this.requestCreationDiscovery(); await interaction.update(this.creationPages(parts[2])); return true;
      }
      if (['newLimits', 'newDungeon', 'newMonster', 'newRefresh', 'create'].includes(action)) {
        throw new Error('This creation screen is outdated. Open /watcher and press Add rule for the new popup.');
      }
      if (action === 'ignoreIds' || action === 'removeIds') {
        const adding = action === 'ignoreIds';
        await interaction.showModal(modal(adding ? 'dw:ignoredAdd' : 'dw:ignoredRemove', adding ? 'Add ignored game players' : 'Remove ignored game players',
          [['ids', 'Game player IDs (spaces or commas)', '', true]])); return true;
      }
      const ruleActions = ['limits', 'saveLimits', 'view', 'refreshRule', 'destination', 'counts', 'dungeon', 'monster', 'channel', 'role', 'noRole', 'toggle', 'enable', 'delete', 'remove'];
      const rule = ruleActions.includes(action) && /^[a-f0-9]{16}$/.test(parts[2] || '') ? this.settings.get(parts[2]) : null;
      if (rule && action !== 'select' && rule.revision !== Number(parts[3])) throw new Error('This panel is outdated. Open /watcher again.');
      if (action === 'limits') {
        await interaction.showModal(modal(this.id('saveLimits', rule), 'Edit damage watcher', [['name', 'Rule name', rule.name], ['x', 'X · Damage must exceed this total', rule.threshold],
          ['y', 'Y · Number of distinct monsters', String(rule.occurrences)], ['h', 'H · Immediate damage limit (optional)', rule.upper || '', false]])); return true;
      }
      const submission = interaction.isModalSubmit?.();
      if (submission && !interaction.isFromMessage?.()) { await interaction.deferReply({ flags: 64 }); deferred = 'reply'; }
      else { await interaction.deferUpdate(); deferred = 'update'; }
      const render = async payload => {
        try { return await interaction.editReply(payload); }
        catch (error) {
          const selector = payload.components?.flatMap(row => row.components || []).find(component => component.custom_id?.startsWith('dw:ignoreSelect:'));
          if (Number(error.code) !== 50035 || !selector) throw error;
          this.ignoreDropdownRejected = true;
          this.log(controlFailure(error, action));
          return interaction.editReply(this.ignored(Number(selector.custom_id.split(':')[3]) || 0,
            'Discord rejected the player dropdown. You can still manage exclusions with Add game IDs, Remove game IDs and Clear all.', true));
        }
      };
      if (action === 'createForm') {
        const selected = id => interaction.fields.getStringSelectValues(id);
        const dungeonValues = selected('dungeon'), monsterValues = selected('monster');
        if (dungeonValues.length !== 1 || monsterValues.length !== 1) throw new Error('Choose exactly one dungeon and one monster.');
        const dungeon = this.active().find(instance => instance.instanceId === dungeonValues[0]);
        const target = this.creationTargets().find(target => target.value === monsterValues[0]);
        if (!dungeon || !target) throw new Error('This creation form has an outdated dungeon or monster. Start Add rule again.');
        if (target.instanceId !== dungeon.instanceId) throw new Error('Choose a monster belonging to the selected dungeon. Each monster lists its dungeon underneath.');
        const value = id => String(interaction.fields.getTextInputValue(id) ?? '');
        const added = this.settings.add({ name: (dungeon.name + ' · ' + target.monsterName).slice(0, 160), dungeonName: dungeon.name, monsterName: target.monsterName,
          threshold: value('x'), occurrences: value('y'), upper: value('h') });
        await render(this.panel(added, null, 'Created paused. Choose the channel, preview, then enable. Rename the automatic rule name with Edit limits.')); return true;
      }
      if (action === 'ignoredAdd' || action === 'ignoredRemove') {
        const text = String(interaction.fields.getTextInputValue('ids') ?? '').trim();
        if (!text) throw new Error('Choose at least one numeric game player ID.');
        const ids = this.settings.validateIds(text.split(/[\s,;]+/));
        const previous = this.settings.data.ignoredPlayerIds;
        const adding = action === 'ignoredAdd';
        const next = adding ? [...new Set([...previous, ...ids])] : previous.filter(id => !ids.includes(id));
        this.settings.ignore(next);
        await render(this.ignored(0, (adding ? 'Added to ignored game IDs: ' : 'Removed from ignored game IDs: ') + ids.join(', ').slice(0, 600))); return true;
      }
      if (action === 'ignored') {
        const ids = String(interaction.fields.getTextInputValue('ids') ?? '').trim();
        this.settings.ignore(ids ? ids.split(/[\s,]+/) : [], parts[2]);
        await render(this.ignored()); return true;
      }
      if (action === 'clearIgnored') {
        await render({ content: 'Clear all ignored game player IDs? These players will be monitored again on the next scan.',
          embeds: [], components: [row(button('Confirm clear all', 'dw:ignoredClear:' + this.settings.data.ignoredRevision, 4), button('Cancel', 'dw:ignore'))], allowedMentions: { parse: [] } }); return true;
      }
      if (action === 'ignoredClear') {
        this.settings.ignore([], parts[2]); await render(this.ignored(0, 'Cleared ignored game player IDs.')); return true;
      }
      if (action === 'ignore' || action === 'ignorePage') { await render(this.ignored(action === 'ignorePage' ? parts[2] : 0)); return true; }
      if (action === 'ignoreSelect') {
        const displayed = this.ignoredChoices().slice(Number(parts[3]) * 25, Number(parts[3]) * 25 + 25);
        if (token(displayed.join(',')) !== parts[4] || interaction.values.some(id => !displayed.includes(id))) throw new Error('This player selection is outdated. Open /watcher again.');
        this.settings.ignore([...this.settings.data.ignoredPlayerIds.filter(id => !displayed.includes(id)), ...interaction.values], parts[2]);
        await render(this.ignored(parts[3])); return true;
      }
      if (action === 'home') { await render(this.home()); return true; }
      if (action === 'refresh') { this.requestCreationDiscovery(); await this.refresh(); await render(this.home('Discovery refreshed. Press Add rule to choose the dungeon, monster and limits in one popup.')); return true; }
      if (action === 'select') { await render(this.panel(this.settings.get(interaction.values[0]))); return true; }
      if (!rule) throw new Error('This watcher rule is no longer available. Open /watcher again.');
      const update = changes => Object.entries(changes).every(([key, value]) => rule[key] === value) ? rule : this.settings.update(rule.id, rule.revision, changes);
      if (action === 'view') await render(this.panel(rule));
      else if (action === 'refreshRule') { await this.refresh(); await render(this.panel(this.settings.get(rule.id), null, 'Discovery refreshed. Larger locations rotate across scans.')); }
      else if (action === 'destination') await render(this.destinations(rule));
      else if (action === 'counts') {
        if (!rule.enabled && !parts[4]) { this.watcher.requestPreview(rule.id); await this.refresh(); }
        await render(this.counts(rule, parts[4]));
      }
      else if (action === 'saveLimits') {
        const value = id => String(interaction.fields.getTextInputValue(id) ?? '');
        await render(this.panel(update({ name: value('name'), threshold: value('x'), occurrences: value('y'), upper: value('h') }), null, 'Saved limits. Existing counts and sent-alert records are retained.'));
      } else if (action === 'dungeon') {
        const dungeon = this.active().find(instance => instance.instanceId === interaction.values[0]);
        if (!dungeon) throw new Error('This dungeon is no longer active. Refresh discovery.');
        if (sameName(rule.dungeonName, dungeon.name)) await render(this.panel(rule));
        else await render(this.panel(update({ dungeonName: dungeon.name, monsterName: 'Select a monster', enabled: false }), null, 'Rule paused. Refresh discovery and choose a monster.'));
      } else if (action === 'monster') {
        const value = interaction.values[0];
        if (value.startsWith('page:')) await render(this.panel(rule, value.slice(5)));
        else {
          const name = this.choices(rule).find(name => token(name) === value);
          if (!name) throw new Error('This monster choice is outdated. Refresh discovery.');
          if (name === rule.monsterName) await render(this.panel(rule));
          else await render(this.panel(update({ monsterName: name, enabled: false }), null, 'Monster saved. Preview and enable when ready.'));
        }
      } else if (action === 'channel') {
        const id = interaction.values[0]; await this.validateChannel(id);
        if (rule.roleId) await this.validateMention({ kind: 'role', roleIds: [rule.roleId] }, id);
        await render(this.destinations(update({ channelId: id })));
      } else if (action === 'role' || action === 'noRole') {
        const roleId = action === 'noRole' ? null : interaction.values[0] || null;
        if (roleId && !rule.channelId) throw new Error('Choose a notification channel first.');
        if (roleId) await this.validateMention({ kind: 'role', roleIds: [roleId] }, rule.channelId);
        await render(this.destinations(update({ roleId })));
      } else if (action === 'toggle') {
        if (rule.enabled) await render(this.panel(update({ enabled: false })));
        else {
          if (!this.choices(rule).includes(rule.monsterName)) throw new Error('Choose a discovered monster before enabling.');
          if (!rule.channelId) throw new Error('Choose a notification channel before enabling.');
          await render({ content: 'Enable **' + clean(rule.name) + '**? Existing damage visible in the current dungeon will count and may trigger alerts on the next scan. Each monster counts once.',
            embeds: [], components: [row(button('Confirm enable', this.id('enable', rule), 3), button('Back', this.id('view', rule)))], allowedMentions: { parse: [] } });
        }
      } else if (action === 'enable') {
        if (!this.choices(rule).includes(rule.monsterName)) throw new Error('Choose a currently discovered monster before enabling.');
        await this.validateChannel(rule.channelId);
        if (rule.roleId) await this.validateMention({ kind: 'role', roleIds: [rule.roleId] }, rule.channelId);
        await render(this.panel(update({ enabled: true }), null, 'Enabled. Periodic scans will read the watched leaderboards.'));
      } else if (action === 'delete') {
        await render({ content: 'Delete **' + clean(rule.name) + '**? This removes the watcher rule, not previous Discord announcements.',
          embeds: [], components: [row(button('Confirm delete', this.id('remove', rule), 4), button('Cancel', this.id('view', rule)))], allowedMentions: { parse: [] } });
      } else if (action === 'remove') { this.settings.remove(rule.id, rule.revision); await render(this.home('Watcher rule deleted.')); }
      else throw new Error('Unknown watcher action. Open /watcher again.');
    } catch (error) {
      const message = /Choose|This |Unknown |Damage value|Leaderboard|The bot needs|Make that role/.test(error.message || '') ? error.message
        : Number(error.code) === 50035 ? 'Discord rejected a watcher control. This is a form error, not your server-owner privileges. Ask the host for the Watcher interface error field details.'
          : Number(error.code) === 50013 ? 'Discord denied access for the bot. Your server privileges do not grant permissions to the bot; check its channel permissions.'
            : 'Watcher action could not finish. This does not necessarily mean a permissions problem. Ask the host for the Watcher interface error line.';
      if (deferred === 'update') await interaction.followUp({ content: message, flags: 64, allowedMentions: { parse: [] } });
      else if (deferred) await interaction.editReply({ content: message, embeds: [], components: [], allowedMentions: { parse: [] } });
      else await replyError(message);
      if (!/Choose|This |Unknown |Damage value|Leaderboard|The bot needs|Make that role/.test(error.message || '')) this.log(controlFailure(error, action));
    }
    return true;
  }
}
module.exports = { WatcherPanel, modal };
