const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inspectLeaderboard } = require('../src/damageParser');
const { WatcherStore } = require('../src/watcherStore');
const { runtime, evaluate, applyLeaderboard, DamageWatcher } = require('../src/damageWatcher');
const { WatcherPanel, modal } = require('../src/watcherPanel');
const { alertPayload } = require('../src/watcherMessages');
const { emptyState, StateStore } = require('../src/storage');
const { DiscordPublisher } = require('../src/discord');
const { GameReader, safeGameUrl } = require('../src/transport');
const { Monitor } = require('../src/monitor');
const { reduceSnapshot } = require('../src/model');
const { BotRuntime } = require('../src/bot');
const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const html = fixture('monster_leaderboard.html');
function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'damage-watch-test-'));
  const settings = new WatcherStore(path.join(directory, 'rules.json'), 'bot:111:222');
  const rule = settings.add({ name: 'Test rule', dungeonName: 'Shadowbridge Warrens', monsterName: 'Gribble Junk-Magus', threshold: '100', occurrences: 2, upper: '500', channelId: '444' });
  settings.update(rule.id, rule.revision, { enabled: true });
  const state = emptyState();
  state.instances['800001'] = { instanceId: '800001', name: 'Shadowbridge Warrens', active: true };
  return { directory, settings, state, rule: settings.get(rule.id), cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}
function observe(state, monsterId, damage, { playerId = '1001', name = 'Same Name', instanceId = '800001', dead = false } = {}) {
  const key = instanceId + ':' + monsterId;
  runtime(state).monsters[key] ||= { instanceId, monsterId, name: 'Gribble Junk-Magus', dungeonName: 'Shadowbridge Warrens',
    url: '/battle.php?instance_id=' + instanceId + '&dgmid=' + monsterId, players: {} };
  applyLeaderboard(state, { instanceId, monsterId, name: 'Gribble Junk-Magus', dead, players: [{ playerId, name, damage: String(damage) }] }, 1000);
}
test('redacted capture exposes 40 ID-keyed cumulative totals, including dead monsters', () => {
  const parsed = inspectLeaderboard(html, { instanceId: '800001', monsterId: '700001', name: 'Gribble Junk-Magus' });
  assert.equal(parsed.players.length, 40); assert.equal(parsed.dead, true);
  assert.deepEqual(parsed.players[0], { playerId: '1001', name: 'Captured Player 1', damage: '16410028' });
  assert.equal(parsed.players[39].damage, '1147236');
});
test('leaderboard rejects mismatched identity, duplicate/missing IDs, malformed totals and pagination', () => {
  const expected = { instanceId: '800001', monsterId: '700001', name: 'Gribble Junk-Magus' };
  for (const source of [html.replace('instanceId: 800001', 'instanceId: 900001'), html.replace('dgmid: 700001', 'dgmid: 999999'),
    html.replace('pid=1002', 'pid=1001'), html.replace('pid=1001', 'pid=invalid'), html.replace('16,410,028 DMG', '16,410,x DMG'),
    html.replace('Attackers Leaderboard', 'Something else'), html.replace('lb-list', 'wrong-list'),
    html.replace('Attackers Leaderboard', 'Attackers Leaderboard Top 40 players'), '<title>Login</title>']) {
    assert.throws(() => inspectLeaderboard(source, expected), { code: 'PARSE_FAILED' });
  }
});
test('damage comparison preserves integer precision beyond Number safe range', () => {
  const source = html.replace('16,410,028 DMG', '9,007,199,254,740,993 DMG');
  assert.equal(inspectLeaderboard(source, { instanceId: '800001', monsterId: '700001' }).players[0].damage, '9007199254740993');
});
test('same monster counts once, totals are max observations, X is strict, Y is distinct monsters', () => {
  const s = setup();
  try {
    observe(s.state, '700001', 100); assert.equal(evaluate(s.state, s.settings, 1000).length, 0);
    observe(s.state, '700001', 101); observe(s.state, '700001', 200); observe(s.state, '700001', 120);
    assert.equal(runtime(s.state).monsters['800001:700001'].players['1001'].damage, '200');
    assert.equal(evaluate(s.state, s.settings, 2000).length, 0);
    observe(s.state, '700002', 200);
    const events = evaluate(s.state, s.settings, 3000);
    assert.equal(events.length, 1); assert.equal(events[0].count, 2); assert.equal(events[0].countTriggered, true);
    assert.equal(evaluate(s.state, s.settings, 4000).length, 0);
    observe(s.state, '700003', 201); assert.equal(evaluate(s.state, s.settings, 5000).length, 0);
  } finally { s.cleanup(); }
});
test('H alerts once per player/monster, and simultaneous X/Y/H triggers combine', () => {
  const s = setup();
  try {
    observe(s.state, '700001', 499); assert.equal(evaluate(s.state, s.settings, 1000).length, 0);
    observe(s.state, '700001', 500);
    const first = evaluate(s.state, s.settings, 2000); assert.equal(first.length, 1); assert.equal(first[0].upperTriggered, true); assert.equal(first[0].countTriggered, false);
    observe(s.state, '700001', 900); assert.equal(evaluate(s.state, s.settings, 3000).length, 0);
    observe(s.state, '700002', 500);
    const second = evaluate(s.state, s.settings, 4000); assert.equal(second.length, 1); assert.equal(second[0].upperTriggered, true); assert.equal(second[0].countTriggered, true);
    assert.equal(evaluate(s.state, s.settings, 5000).length, 0);
  } finally { s.cleanup(); }
});
test('ignored game IDs survive rename, equal names are separate players', () => {
  const s = setup();
  try {
    s.settings.ignore(['1001']);
    observe(s.state, '700001', 600, { playerId: '1001', name: 'Changed Name' });
    observe(s.state, '700001', 600, { playerId: '1002', name: 'Changed Name' });
    const events = evaluate(s.state, s.settings, 2000);
    assert.equal(events.length, 1); assert.equal(events[0].playerId, '1002');
    assert.deepEqual(new WatcherStore(s.settings.file, s.settings.owner).data.ignoredPlayerIds, ['1001']);
    assert.throws(() => s.settings.ignore(['Changed Name']), /numeric game player IDs/);
  } finally { s.cleanup(); }
});
test('restart retains deduplication, and a new instance of the same dungeon starts fresh', () => {
  const s = setup();
  try {
    observe(s.state, '700001', 600); evaluate(s.state, s.settings, 1000);
    const store = new StateStore(path.join(s.directory, 'state.json')); store.state = s.state; store.save();
    const restored = new StateStore(store.file);
    assert.equal(evaluate(restored.state, s.settings, 2000).length, 0);
    restored.state.instances['800001'].active = false;
    restored.state.instances['800002'] = { instanceId: '800002', name: 'Shadowbridge Warrens', active: true };
    observe(restored.state, '700001', 600, { instanceId: '800002' });
    const events = evaluate(restored.state, s.settings, 3000); assert.equal(events.length, 1); assert.equal(events[0].instanceId, '800002');
  } finally { s.cleanup(); }
});
test('settings reject stale edits, wrong server, invalid limits, and failed writes apply nothing', () => {
  const s = setup();
  try {
    assert.throws(() => s.settings.update(s.rule.id, 1, { threshold: '200' }), /outdated/);
    assert.throws(() => new WatcherStore(s.settings.file, 'another server'), /another Discord/);
    for (const changes of [{ upper: '50' }, { occurrences: 0 }, { threshold: '-1' }, { occurrences: 1.5 }]) {
      assert.throws(() => s.settings.update(s.rule.id, s.rule.revision, changes));
    }
    const currentRevision = s.settings.data.ignoredRevision; s.settings.ignore(['1001']);
    assert.throws(() => s.settings.ignore(['1002'], currentRevision), /outdated/);
    fs.mkdirSync(path.join(s.directory, 'blocked')); s.settings.file = path.join(s.directory, 'blocked');
    assert.throws(() => s.settings.update(s.rule.id, s.rule.revision, { threshold: '200' }));
    assert.equal(s.settings.get(s.rule.id).threshold, '100');
  } finally { s.cleanup(); }
});
test('only exact dungeon battle GET locators are allowed, attack/join routes remain rejected', async () => {
  assert.equal(safeGameUrl('/battle.php?instance_id=800001&dgmid=700001').pathname, '/battle.php');
  for (const value of ['/battle.php?id=700001', '/battle.php?instance_id=800001', '/battle.php?instance_id=800001&dgmid=700001&action=join', '/damage.php', '/dungeon_join_battle.php']) {
    assert.throws(() => safeGameUrl(value));
  }
  let method;
  const reader = new GameReader({ header: () => '', applySetCookies() {} }, { requestGapMilliseconds: 0, requestTimeoutSeconds: 5 }, async (_, options) => {
    method = options.method; return new Response(html);
  });
  await reader.get('/battle.php?instance_id=800001&dgmid=700001'); assert.equal(method, 'GET');
});
test('watcher reads only configured dungeons, respects budget, sees dead mobs and never repeatedly reads final totals', async () => {
  const s = setup();
  try {
    const calls = [];
    const location = fixture('dungeon_location_shadowbridge.html').replaceAll('Vorga Ash-Shaman', 'Gribble Junk-Magus');
    const scanner = { session: { owner: () => 'owner' }, reader: { get: async url => {
      calls.push(url); return { body: String(url).startsWith('/battle.php') ? html.replace('dgmid: 700001', 'dgmid: ' + new URL(url, 'https://demonicscans.org').searchParams.get('dgmid')) : location };
    } } };
    const store = { state: s.state, save() {} };
    const watcher = new DamageWatcher(scanner, store, s.settings, { watcherReadBudget: 3, pollSeconds: 60 }, () => 1000);
    const snapshot = { owner: 'owner', instances: [{ ...s.state.instances['800001'], locations: [{ instanceId: '800001', locationId: '1', name: 'brood pits', url: '/guild_dungeon_location.php?instance_id=800001&location_id=1' }] },
      { instanceId: '999999', name: 'Unselected Dungeon', active: true, locations: [{ url: '/should-not-read' }] }] };
    await watcher.scan(snapshot);
    assert.equal(calls.length, 3); assert(calls.some(url => url.includes('dgmid=700002'))); assert.equal(runtime(s.state).monsters['800001:700002'].finalRead, true);
    assert.equal(Object.values(s.state.outbox).length, 40);
    await watcher.scan(snapshot); assert.equal(calls.length, 4); assert.equal(runtime(s.state).health.status, 'ok');
    const before = JSON.stringify(s.state.outbox); watcher.preview(s.rule); assert.equal(JSON.stringify(s.state.outbox), before);
  } finally { s.cleanup(); }
});
test('leaderboard failures preserve observed totals and expose watcher health', async () => {
  const s = setup();
  try {
    observe(s.state, '700001', 101);
    const scanner = { session: { owner: () => 'owner' }, reader: { get: async () => ({ body: '<title>Unknown</title>' }) } };
    const watcher = new DamageWatcher(scanner, { state: s.state, save() {} }, s.settings, { watcherReadBudget: 3, pollSeconds: 60 }, () => 1000);
    await watcher.scan({ owner: 'owner', instances: [{ ...s.state.instances['800001'], locations: [] }] });
    assert.equal(runtime(s.state).monsters['800001:700001'].players['1001'].damage, '101');
    assert.equal(runtime(s.state).health.status, 'partial'); assert.equal(Object.keys(s.state.outbox).length, 0);
  } finally { s.cleanup(); }
});
test('watcher failure cannot break dungeon monitoring and rolls back partial watcher mutations', async () => {
  const state = emptyState(), store = { state, save() {} }; let published = 0;
  const monitor = new Monitor({ scan: async () => ({ owner: 'owner', instances: [], observedAt: 1000, warnings: [] }) }, store, { publish: async () => { published++; } }, {}, () => {});
  monitor.watcher = { scan: async () => { runtime(state).monsters.bad = {}; state.outbox.bad = {}; throw new Error('Account changed'); } };
  await monitor.cycle();
  assert.equal(published, 1); assert.equal(state.health.status, 'ok'); assert.equal(state.watcher.monsters.bad, undefined); assert.equal(state.outbox.bad, undefined);
  assert.equal(state.watcher.health.status, 'error');
});
test('watch alerts use a separate channel and persistent uncertain delivery is never automatically repeated', async () => {
  const s = setup();
  try {
    observe(s.state, '700001', 600); const event = evaluate(s.state, s.settings, 1000)[0];
    const calls = []; const store = { state: s.state, save() {} };
    const publisher = new DiscordPublisher({ applicationId: '111', channelId: '333', announcements: true, dashboard: false }, store, { token: 'mock', fetcher: async url => {
      calls.push(url.pathname); throw new Error('lost response');
    }, log() {} });
    publisher.watcherSettings = s.settings;
    await publisher.publish(); await publisher.publish();
    assert.deepEqual(calls, ['/api/v10/channels/444/messages']); assert.equal(event.status, 'uncertain');
    const payload = alertPayload(event);
    assert.equal(payload.components[0].components[0].custom_id.length < 100, true);
    assert.deepEqual(payload.allowed_mentions, { parse: [], users: [], roles: [] });
  } finally { s.cleanup(); }
});
test('ignored or paused players cancel queued watch alerts without blocking regular messages', async () => {
  const s = setup();
  try {
    observe(s.state, '700001', 600); const event = evaluate(s.state, s.settings, 1000)[0]; s.settings.ignore(['1001']);
    s.state.outbox.normal = { id: 'normal', type: 'opened', name: 'Dungeon', instanceId: '800001', url: '/guild_dungeon.php', observedAt: 1000, status: 'queued' };
    let posts = 0;
    const publisher = new DiscordPublisher({ channelId: '333', announcements: true, dashboard: false }, { state: s.state, save() {} }, { token: 'mock', fetcher: async () => { posts++; return new Response('{"id":"555"}'); } });
    publisher.watcherSettings = s.settings; await publisher.publish();
    assert.equal(event.status, 'cancelled'); assert.equal(posts, 1); assert.equal(s.state.outbox.normal.status, 'delivered');
  } finally { s.cleanup(); }
});
function interaction(action, { admin = true, guildId = '222', modal = false, fromMessage = false, values = [], fields = {} } = {}) {
  const replies = [];
  const calls = [];
  return { customId: action, guildId, values, replies, calls, memberPermissions: { has: () => admin }, isChatInputCommand: () => action === 'slash',
    commandName: 'watcher', isModalSubmit: () => modal, isFromMessage: () => fromMessage, fields: { getTextInputValue: key => fields[key] ?? '' },
    reply: async value => { calls.push('reply'); replies.push(value); }, deferReply: async value => { calls.push('deferReply'); replies.push(value); },
    deferUpdate: async () => { calls.push('deferUpdate'); replies.push('deferred'); }, update: async value => { calls.push('update'); replies.push(value); },
    editReply: async value => { calls.push('editReply'); replies.push(value); }, followUp: async value => { calls.push('followUp'); replies.push(value); },
    showModal: async value => { calls.push('showModal'); replies.push(value); } };
}
function panel(s) {
  return new WatcherPanel({ config: { guildId: '222', operatorRoleIds: ['777'] }, settings: s.settings, watcher: { preview: () => [], requestDiscovery() {}, requestPreview() {} },
    monitor: { store: { state: s.state }, cycle: async () => {} }, validateChannel: async () => {}, validateMention: async () => {} });
}
test('Discord watcher panel is public while unauthorized and stale-edit errors remain private', async () => {
  const s = setup();
  try {
    const ui = panel(s);
    for (const i of [interaction('slash', { admin: false }), interaction('dw:toggle:' + s.rule.id + ':' + s.rule.revision, { guildId: 'wrong' })]) {
      await ui.handle(i); assert.equal(i.replies[0].flags, 64); assert(i.replies[0].content.includes('server') || i.replies[0].content.includes('operator'));
    }
    const slash = interaction('slash'); await ui.handle(slash); assert.equal(slash.replies[0].flags, undefined); assert(slash.replies[0].embeds[0].title.includes('Damage Watcher'));
    const stale = interaction('dw:toggle:' + s.rule.id + ':1'); await ui.handle(stale); assert(stale.replies[0].content.includes('outdated'));
    assert.equal(s.settings.get(s.rule.id).enabled, true);
    const role = interaction('slash', { admin: false }); role.member = { roles: ['777'] }; await ui.handle(role); assert(role.replies[0].embeds);
  } finally { s.cleanup(); }
});
test('manual exclusions and captured-player selects persist only game IDs with stale-form protection', async () => {
  const s = setup();
  try {
    observe(s.state, '700001', 200, { playerId: '1001', name: 'Same Name' }); observe(s.state, '700001', 200, { playerId: '1002', name: 'Same Name' });
    const ui = panel(s), payload = ui.ignored();
    const choices = payload.components[0].components[0].options;
    assert.deepEqual(choices.map(option => option.value), ['1001', '1002']);
    const pick = interaction(payload.components[0].components[0].custom_id, { values: ['1001'] }); await ui.handle(pick); assert.deepEqual(s.settings.data.ignoredPlayerIds, ['1001']);
    const stale = interaction('dw:ignored:1', { modal: true, fields: { ids: '1002' } }); await ui.handle(stale); assert(stale.replies.at(-1).content.includes('outdated'));
    const clear = interaction('dw:ignored:2', { modal: true, fields: { ids: '' } }); await ui.handle(clear); assert.deepEqual(s.settings.data.ignoredPlayerIds, []);
  } finally { s.cleanup(); }
});
test('panel requires confirmation to enable/delete and validates channels before saving', async () => {
  const s = setup();
  try {
    const rule = s.settings.update(s.rule.id, s.rule.revision, { enabled: false });
    observe(s.state, '700001', 101);
    const ui = panel(s);
    const enable = interaction(ui.id('toggle', rule)); await ui.handle(enable);
    assert(enable.replies.at(-1).content.includes('Existing damage')); assert.equal(s.settings.get(rule.id).enabled, false);
    ui.validateChannel = async () => { throw new Error('Choose a valid channel'); };
    const bad = interaction(ui.id('channel', rule), { values: ['555'] }); await ui.handle(bad); assert.equal(s.settings.get(rule.id).channelId, '444');
    const confirm = interaction(ui.id('enable', rule)); await ui.handle(confirm); assert.equal(s.settings.get(rule.id).enabled, false);
    ui.validateChannel = async () => {};
    await ui.handle(interaction(ui.id('enable', rule))); assert.equal(s.settings.get(rule.id).enabled, true);
    const current = s.settings.get(rule.id);
    await ui.handle(interaction(ui.id('delete', current))); assert.equal(s.settings.rules().length, 1);
    await ui.handle(interaction(ui.id('remove', current))); assert.equal(s.settings.rules().length, 0);
  } finally { s.cleanup(); }
});
test('panel/modal payloads stay within Discord component limits and sanitize game text', () => {
  const s = setup();
  try {
    const ui = panel(s);
    for (const payload of [ui.home(), ui.panel(s.rule), ui.destinations(s.rule), ui.ignored(), ui.counts(s.rule)]) {
      assert(payload.components.length <= 5);
      for (const row of payload.components) {
        assert(row.components.length <= 5);
        for (const item of row.components) { if (item.options) assert(item.options.length <= 25); if (item.custom_id) assert(item.custom_id.length <= 100); }
      }
    }
    const form = modal('dw:test', 'Test', [['x', 'X limit', '100']]);
    assert.equal(form.components[0].type, 18); assert.equal(form.components[0].component.type, 4);
    const payload = alertPayload({ ...evaluateAfterHit(s), playerName: '@everyone **bad**' });
    assert(!payload.embeds[0].description.includes('@everyone')); assert.deepEqual(payload.allowed_mentions.parse, []);
  } finally { s.cleanup(); }
});
function evaluateAfterHit(s) { observe(s.state, '700001', 600); return evaluate(s.state, s.settings, 1000)[0]; }

test('watcher cards require Embed Links without changing regular dungeon channel requirements', async () => {
  const context = { config: { guildId: '222' }, client: { user: {}, channels: { fetch: async () => ({ type: 0, guildId: '222',
    permissionsFor: () => ({ has: bit => bit !== 16384n }) }) } } };
  await BotRuntime.prototype.validateChannel.call(context, '333');
  await assert.rejects(BotRuntime.prototype.validateChannel.call(context, '333', { embeds: true }), /Embed Links/);
  const s = setup();
  try {
    const i = interaction('slash'); i.appPermissions = { has: () => false };
    await panel(s).handle(i); assert(i.replies[0].content.includes('Embed Links')); assert.equal(i.replies[0].flags, 64);
  } finally { s.cleanup(); }
});

test('changing the monitoring account clears old watcher observations while old v1 files load safely', () => {
  const s = setup();
  try {
    s.state.owner = 'old-account'; observe(s.state, '700001', 600); evaluate(s.state, s.settings, 1000);
    reduceSnapshot(s.state, { owner: 'new-account', instances: [], observedAt: 2000, warnings: [] });
    assert.deepEqual(runtime(s.state).monsters, {}); assert.deepEqual(runtime(s.state).alerted, {});
    const file = path.join(s.directory, 'old-state.json');
    const old = emptyState(); delete old.watcher; fs.writeFileSync(file, JSON.stringify(old));
    assert.deepEqual(new StateStore(file).state.watcher.monsters, {});
  } finally { s.cleanup(); }
});
test('paused rule previews sample leaderboard totals without enqueuing or changing the rule', async () => {
  const s = setup();
  try {
    const rule = s.settings.update(s.rule.id, s.rule.revision, { enabled: false });
    const scanner = { session: { owner: () => 'owner' }, reader: { get: async () => ({ body: html }) } };
    const watcher = new DamageWatcher(scanner, { state: s.state, save() {} }, s.settings, { watcherReadBudget: 3, pollSeconds: 60 }, () => 1000);
    runtime(s.state).monsters['800001:700001'] = { instanceId: '800001', monsterId: '700001', name: 'Gribble Junk-Magus', dungeonName: 'Shadowbridge Warrens',
      url: '/battle.php?instance_id=800001&dgmid=700001', players: {} };
    watcher.requestPreview(rule.id); await watcher.scan({ owner: 'owner', instances: [s.state.instances['800001']] });
    assert.equal(runtime(s.state).monsters['800001:700001'].players['1001'].damage, '16410028');
    assert.equal(Object.keys(s.state.outbox).length, 0); assert.equal(s.settings.get(rule.id).enabled, false);
    assert.equal(watcher.preview(rule).length, 40); assert.equal(watcher.previewRequests.size, 0);
  } finally { s.cleanup(); }
});
test('discovery and leaderboard rotation are bounded and fair across scans', async () => {
  const s = setup();
  try {
    const locationUrls = Array.from({ length: 4 }, (_, i) => '/guild_dungeon_location.php?instance_id=800001&location_id=' + (i + 1));
    const calls = [];
    const scanner = { session: { owner: () => 'owner' }, reader: { get: async url => { calls.push(url); return { body: '<title>Shadowbridge Warrens</title><div>Monsters in this location</div>' }; } } };
    const watcher = new DamageWatcher(scanner, { state: s.state, save() {} }, s.settings, { watcherReadBudget: 3, pollSeconds: 60 });
    const snapshot = { owner: 'owner', instances: [{ ...s.state.instances['800001'], locations: locationUrls.map((url, i) => ({ url, instanceId: '800001', locationId: String(i + 1), name: 'Room ' + i })) }] };
    for (let i = 0; i < 4; i++) await watcher.scan(snapshot);
    assert.deepEqual(calls, locationUrls);
  } finally { s.cleanup(); }
});
test('cached boss pages are reused for discovery without another network request', async () => {
  const s = setup();
  try {
    const paused = s.settings.update(s.rule.id, s.rule.revision, { enabled: false });
    let reads = 0;
    const url = '/guild_dungeon_location.php?instance_id=800001&location_id=1';
    const scanner = { session: { owner: () => 'owner' }, reader: { get: async () => { reads++; throw new Error('Unexpected network read'); } } };
    const watcher = new DamageWatcher(scanner, { state: s.state, save() {} }, s.settings, { watcherReadBudget: 3, pollSeconds: 60 });
    await watcher.scan({ owner: 'owner', pages: new Map([[safeGameUrl(url).toString(), { body: fixture('dungeon_location_shadowbridge.html') }]]),
      instances: [{ ...s.state.instances['800001'], locations: [{ url, instanceId: '800001', locationId: '1', name: 'brood pits' }] }] });
    assert.equal(reads, 0); assert.equal(runtime(s.state).health.status, 'ok'); assert.equal(s.settings.get(paused.id).enabled, false);
  } finally { s.cleanup(); }
});

test('Discord SDK validates native forms, embeds and component payloads without network access', () => {
  const sdk = require('discord.js'), s = setup();
  try {
    const ui = panel(s);
    for (const payload of [ui.home(), ui.panel(s.rule), ui.destinations(s.rule), ui.ignored()]) {
      for (const embed of payload.embeds || []) assert(sdk.EmbedBuilder.from(embed).toJSON());
      for (const component of payload.components || []) assert(sdk.ActionRowBuilder.from(component).toJSON());
    }
    assert(sdk.ModalBuilder.from(modal('dw:form', 'Watcher limits', [['x', 'X limit', '100'], ['h', 'Optional H', '', false]])).toJSON());
    const alert = alertPayload(evaluateAfterHit(s));
    assert(sdk.EmbedBuilder.from(alert.embeds[0]).toJSON()); assert(sdk.ActionRowBuilder.from(alert.components[0]).toJSON());
  } finally { s.cleanup(); }
});
test('rate-limited watcher channels defer their queue without blocking the dungeon channel', async () => {
  const s = setup();
  try {
    observe(s.state, '700001', 600); observe(s.state, '700001', 600, { playerId: '1002' }); evaluate(s.state, s.settings, 1000);
    s.state.outbox.normal = { id: 'normal', type: 'opened', name: 'Dungeon', instanceId: '800001', url: '/guild_dungeon.php', observedAt: 1000, status: 'queued' };
    const calls = [];
    const publisher = new DiscordPublisher({ channelId: '333', announcements: true, dashboard: false }, { state: s.state, save() {} }, { token: 'mock', now: () => 1000,
      fetcher: async url => { calls.push(url.pathname); return url.pathname.includes('/444/') ? new Response('{"retry_after":120}', { status: 429 }) : new Response('{"id":"555"}'); }, log() {} });
    publisher.watcherSettings = s.settings; await publisher.publish();
    assert.deepEqual(calls, ['/api/v10/channels/444/messages', '/api/v10/channels/333/messages']);
    const events = Object.values(s.state.outbox).filter(event => event.type === 'damage_watch');
    assert(events.every(event => event.status === 'queued' && event.retryAt === 121000)); assert.equal(s.state.outbox.normal.status, 'delivered');
  } finally { s.cleanup(); }
});

test('saved rule, dungeon, monster, channel and role stay selected across redraws', async () => {
  const s = setup();
  try {
    observe(s.state, '700001', 101);
    const rule = s.settings.update(s.rule.id, s.rule.revision, { roleId: '555' });
    const ui = panel(s), view = ui.panel(rule);
    assert.equal(view.components[0].components[0].options.find(option => option.default).value, rule.id);
    assert.equal(view.components[1].components[0].options.find(option => option.default).value, '800001');
    assert.equal(view.components[2].components[0].options.find(option => option.default).label, 'Gribble Junk-Magus');
    const destination = ui.destinations(rule);
    assert.deepEqual(destination.components[0].components[0].default_values, [{ id: '444', type: 'channel' }]);
    assert.deepEqual(destination.components[1].components[0].default_values, [{ id: '555', type: 'role' }]);
    const changed = interaction(ui.id('channel', rule), { values: ['666'] }); await ui.handle(changed);
    const updated = changed.replies.at(-1);
    assert.deepEqual(updated.components[0].components[0].default_values, [{ id: '666', type: 'channel' }]);
    assert.deepEqual(updated.components[1].components[0].default_values, [{ id: '555', type: 'role' }]);
    for (const component of updated.components) require('discord.js').ActionRowBuilder.from(component).toJSON();
  } finally { s.cleanup(); }
});

test('selected monsters beyond the first page remain visible after saves and refreshes', () => {
  const s = setup();
  try {
    for (let i = 0; i < 35; i++) runtime(s.state).monsters['800001:' + (700000 + i)] = { instanceId: '800001', name: 'Monster ' + String(i).padStart(2, '0') };
    const rule = s.settings.update(s.rule.id, s.rule.revision, { monsterName: 'Monster 34' });
    const view = panel(s).panel(rule);
    const selector = view.components.map(row => row.components[0]).find(component => component.placeholder?.startsWith('Monster:'));
    assert.equal(selector.options.find(option => option.default).label, 'Monster 34');
    assert(selector.options.length <= 25);
  } finally { s.cleanup(); }
});

function sdkFields(form, values) {
  const sdk = require('discord.js');
  const response = form.components.map(component => component.type === 18
    ? { type: 18, component: { type: component.component.type, custom_id: component.component.custom_id,
      ...(component.component.type === 3 ? { values: values[component.component.custom_id] || [] } : { value: values[component.component.custom_id] ?? '' }) } }
    : component);
  return new sdk.ModalSubmitFields(response.map(component => sdk.ModalSubmitInteraction.transformComponent(component)));
}

test('one popup collects dungeon, monster and X/Y/H with native Discord select and text fields', async () => {
  const s = setup();
  try {
    s.settings.remove(s.rule.id, s.rule.revision);
    s.state.instances = { '900001': { instanceId: '900001', name: 'Different Dungeon', active: true }, ...s.state.instances };
    observe(s.state, '700001', 101);
    const ui = panel(s), requested = [];
    ui.watcher.requestDiscovery = id => requested.push(id);
    const start = interaction('dw:new'); await ui.handle(start);
    assert.deepEqual(start.calls, ['showModal']); assert.equal(s.settings.rules().length, 0);
    assert.deepEqual(new Set(requested), new Set(['900001', '800001']));
    const form = start.replies[0];
    assert.equal(form.components.length, 5);
    assert.deepEqual(form.components.map(label => label.component.custom_id), ['dungeon', 'monster', 'x', 'y', 'h']);
    const target = form.components[1].component.options[0];
    assert.equal(target.label, 'Gribble Junk-Magus'); assert(target.description.includes('Shadowbridge Warrens'));
    require('discord.js').ModalBuilder.from(form).toJSON();
    const submit = interaction(form.custom_id, { modal: true, fromMessage: true });
    submit.fields = sdkFields(form, { dungeon: ['800001'], monster: [target.value], x: '1,000', y: '3', h: '5000' });
    await ui.handle(submit);
    assert.deepEqual(submit.calls, ['deferUpdate', 'editReply']);
    const rule = s.settings.rules()[0];
    assert.equal(rule.dungeonName, 'Shadowbridge Warrens'); assert.equal(rule.monsterName, 'Gribble Junk-Magus');
    assert.equal(rule.name, 'Shadowbridge Warrens · Gribble Junk-Magus');
    assert.equal(rule.threshold, '1000'); assert.equal(rule.upper, '5000'); assert.equal(rule.enabled, false);
    assert.equal(submit.replies.at(-1).components[0].components[0].options[0].default, true);
  } finally { s.cleanup(); }
});

test('creating a rule rejects a dungeon that closed while the form was open', async () => {
  const s = setup();
  try {
    observe(s.state, '700001', 101);
    const ui = panel(s), form = ui.creationForm();
    const option = form.components[1].component.options[0].value;
    s.state.instances['800001'].active = false;
    const submit = interaction(form.custom_id, { modal: true, fromMessage: true });
    submit.fields = sdkFields(form, { dungeon: ['800001'], monster: [option], x: '100', y: '1' });
    await ui.handle(submit);
    assert.equal(s.settings.rules().length, 1); assert.deepEqual(submit.calls, ['deferUpdate', 'followUp']);
    assert.equal(submit.replies.at(-1).flags, 64); assert(submit.replies.at(-1).content.includes('outdated'));
  } finally { s.cleanup(); }
});

test('first-time creation can discover monsters without any saved rule or battle POST', async () => {
  const s = setup();
  try {
    s.settings.remove(s.rule.id, s.rule.revision);
    const calls = [];
    const scanner = { session: { owner: () => 'owner' }, reader: { get: async url => { calls.push(url); return { body: fixture('dungeon_location_shadowbridge.html') }; } } };
    const watcher = new DamageWatcher(scanner, { state: s.state, save() {} }, s.settings, { watcherReadBudget: 3, pollSeconds: 60 }, () => 1000);
    const location = { instanceId: '800001', locationId: '1', name: 'brood pits', url: '/guild_dungeon_location.php?instance_id=800001&location_id=1' };
    const snapshot = { owner: 'owner', instances: [{ ...s.state.instances['800001'], locations: [location] }] };
    await watcher.scan(snapshot); assert.equal(calls.length, 0);
    watcher.requestDiscovery('800001'); await watcher.scan(snapshot);
    assert.equal(calls.length, 1); assert.equal(runtime(s.state).monsters['800001:700001'].name, 'Vorga Ash-Shaman');
    assert.equal(s.settings.rules().length, 0); assert.equal(Object.keys(s.state.outbox).length, 0);
    assert.throws(() => watcher.requestDiscovery('900001'), /no longer active/);
  } finally { s.cleanup(); }
});

test('native Add/Remove ID forms merge with existing exclusions and update the shared panel', async () => {
  const s = setup();
  try {
    s.settings.ignore(['1001']);
    const ui = panel(s), open = interaction('dw:ignoreIds'); await ui.handle(open);
    const form = open.replies[0]; require('discord.js').ModalBuilder.from(form).toJSON();
    assert.equal(form.custom_id, 'dw:ignoredAdd'); assert.equal(form.components[0].component.value, '');
    s.settings.ignore(['1001', '1002']); // Another operator edits after this form was opened.
    const add = interaction(form.custom_id, { modal: true, fromMessage: true });
    add.fields = sdkFields(form, { ids: '12345, 67890' }); await ui.handle(add);
    assert.deepEqual(s.settings.data.ignoredPlayerIds, ['1001', '1002', '12345', '67890']);
    assert.deepEqual(add.calls, ['deferUpdate', 'editReply']); assert(add.replies.at(-1).content.includes('Added to ignored'));
    assert.equal(add.replies.at(-1).flags, undefined);
    const removeForm = interaction('dw:removeIds'); await ui.handle(removeForm);
    const remove = interaction(removeForm.replies[0].custom_id, { modal: true, fromMessage: true });
    remove.fields = sdkFields(removeForm.replies[0], { ids: '12345' }); await ui.handle(remove);
    assert.deepEqual(s.settings.data.ignoredPlayerIds, ['1001', '1002', '67890']);
    assert(remove.replies.at(-1).content.includes('Removed from ignored'));
  } finally { s.cleanup(); }
});

test('invalid, blank and legacy nullable ID submissions never destroy the shared panel', async () => {
  const s = setup();
  try {
    s.settings.ignore(['1001']); const ui = panel(s);
    for (const ids of ['', 'Not A Game ID']) {
      const submit = interaction('dw:ignoredAdd', { modal: true, fromMessage: true, fields: { ids } }); await ui.handle(submit);
      assert.deepEqual(submit.calls, ['deferUpdate', 'followUp']); assert.equal(submit.replies.at(-1).flags, 64);
      assert.deepEqual(s.settings.data.ignoredPlayerIds, ['1001']);
    }
    const old = interaction('dw:ignored:' + s.settings.data.ignoredRevision, { modal: true, fromMessage: true });
    old.fields.getTextInputValue = () => null; await ui.handle(old);
    assert.deepEqual(s.settings.data.ignoredPlayerIds, []); assert.deepEqual(old.calls, ['deferUpdate', 'editReply']);
    const denied = interaction('dw:ignoredAdd', { modal: true, fromMessage: true, admin: false, fields: { ids: '1002' } }); await ui.handle(denied);
    assert.deepEqual(s.settings.data.ignoredPlayerIds, []); assert.equal(denied.replies[0].flags, 64);
  } finally { s.cleanup(); }
});

test('clearing all ignored IDs requires confirmation and stale confirmation preserves current settings', async () => {
  const s = setup();
  try {
    s.settings.ignore(['1001']);
    const ui = panel(s), open = interaction('dw:clearIgnored'); await ui.handle(open);
    assert.deepEqual(s.settings.data.ignoredPlayerIds, ['1001']);
    const confirmId = open.replies.at(-1).components[0].components[0].custom_id;
    s.settings.ignore(['1001', '1002']);
    const stale = interaction(confirmId); await ui.handle(stale);
    assert.deepEqual(s.settings.data.ignoredPlayerIds, ['1001', '1002']); assert.deepEqual(stale.calls, ['deferUpdate', 'followUp']);
    await ui.handle(interaction('dw:ignoredClear:' + s.settings.data.ignoredRevision));
    assert.deepEqual(s.settings.data.ignoredPlayerIds, []);
  } finally { s.cleanup(); }
});

test('channel permission errors keep the shared controls intact and only show a private error', async () => {
  const s = setup();
  try {
    const ui = panel(s); ui.validateChannel = async () => { throw new Error('The bot needs access to that channel'); };
    const change = interaction(ui.id('channel', s.rule), { values: ['666'] }); await ui.handle(change);
    assert.deepEqual(change.calls, ['deferUpdate', 'followUp']); assert.equal(change.replies.at(-1).flags, 64);
    assert.equal(s.settings.get(s.rule.id).channelId, '444');
  } finally { s.cleanup(); }
});

test('reselecting saved settings does not pause enabled rules or invalidate their revision', async () => {
  const s = setup();
  try {
    observe(s.state, '700001', 101);
    const ui = panel(s), view = ui.panel(s.rule);
    await ui.handle(interaction(view.components[1].components[0].custom_id, { values: ['800001'] }));
    await ui.handle(interaction(view.components[2].components[0].custom_id, { values: [view.components[2].components[0].options[0].value] }));
    await ui.handle(interaction(ui.id('channel', s.rule), { values: [s.rule.channelId] }));
    assert.equal(s.settings.get(s.rule.id).revision, s.rule.revision); assert.equal(s.settings.get(s.rule.id).enabled, true);
  } finally { s.cleanup(); }
});

test('one-popup creation rejects cross-dungeon monsters and distinguishes identical monster names', async () => {
  const s = setup();
  try {
    observe(s.state, '700001', 101);
    s.state.instances['900001'] = { instanceId: '900001', name: 'Different Dungeon', active: true };
    runtime(s.state).monsters['900001:700002'] = { instanceId: '900001', monsterId: '700002', name: 'Gribble Junk-Magus' };
    const ui = panel(s), form = ui.creationForm();
    const options = form.components[1].component.options;
    assert.equal(options.length, 2); assert.notEqual(options[0].value, options[1].value);
    const target = options.find(option => option.description.startsWith('Different Dungeon'));
    const submit = interaction(form.custom_id, { modal: true, fromMessage: true });
    submit.fields = sdkFields(form, { dungeon: ['800001'], monster: [target.value], x: '100', y: '1' });
    await ui.handle(submit);
    assert.deepEqual(submit.calls, ['deferUpdate', 'followUp']); assert.equal(submit.replies.at(-1).flags, 64);
    assert(submit.replies.at(-1).content.includes('belonging')); assert.equal(s.settings.rules().length, 1);
  } finally { s.cleanup(); }
});

test('empty creation data requests discovery without creating an incomplete rule', async () => {
  const s = setup();
  try {
    s.settings.remove(s.rule.id, s.rule.revision);
    const ui = panel(s), requested = []; ui.watcher.requestDiscovery = id => requested.push(id);
    const open = interaction('dw:new'); await ui.handle(open);
    assert.deepEqual(open.calls, ['update']); assert(open.replies[0].content.includes('Refresh discovery'));
    assert.deepEqual(requested, ['800001']); assert.equal(s.settings.rules().length, 0);
    let refreshes = 0; ui.monitor.cycle = async () => { refreshes++; observe(s.state, '700001', 101); };
    await ui.handle(interaction('dw:refresh'));
    assert.equal(refreshes, 1); assert.equal(s.settings.rules().length, 0);
    const ready = interaction('dw:new'); await ui.handle(ready);
    assert.deepEqual(ready.calls, ['showModal']); assert.equal(ready.replies[0].components.length, 5);
  } finally { s.cleanup(); }
});

test('all monster choices remain accessible through modal pages without exceeding Discord limits', async () => {
  const s = setup();
  try {
    for (let i = 0; i < 35; i++) runtime(s.state).monsters['800001:' + (700000 + i)] = { instanceId: '800001', name: 'Monster ' + String(i).padStart(2, '0') };
    const ui = panel(s), sdk = require('discord.js');
    assert(ui.home().components.flatMap(row => row.components).some(item => item.custom_id === 'dw:newPages'));
    const pages = ui.creationPages(); assert.equal(pages.components[0].components[0].options.length, 2);
    const last = interaction('dw:newPage', { values: ['1'] }); await ui.handle(last);
    const form = last.replies[0]; assert.equal(form.components.length, 5);
    assert.equal(form.components[1].component.options.length, 10);
    assert(form.components[1].component.options.some(option => option.label === 'Monster 34'));
    sdk.ModalBuilder.from(form).toJSON();
    const values = [ui.creationForm(0), ui.creationForm(1)].flatMap(form => form.components[1].component.options.map(option => option.value));
    assert.equal(new Set(values).size, 35);
  } finally { s.cleanup(); }
});

test('old creation-wizard controls fail privately instead of creating placeholder rules', async () => {
  const s = setup();
  try {
    const ui = panel(s);
    for (const id of ['dw:newDungeon', 'dw:newLimits:800001:old', 'dw:create:800001:old']) {
      const old = interaction(id); await ui.handle(old);
      assert.equal(old.replies[0].flags, 64); assert(old.replies[0].content.includes('outdated'));
      assert.equal(s.settings.rules().length, 1);
    }
  } finally { s.cleanup(); }
});

test('ignored-player menu accepts symbol-only, blank, long and non-string display names using ID fallbacks', async () => {
  const s = setup();
  try {
    const players = runtime(s.state).players;
    for (const [id, name] of Object.entries({ '1001': '___', '1002': '', '1003': 'x'.repeat(400), '1004': 123 })) players[id] = { name };
    const ui = panel(s), payload = ui.ignored();
    const sdk = require('discord.js');
    for (const row of payload.components) sdk.ActionRowBuilder.from(row).toJSON();
    const options = payload.components[0].components[0].options;
    assert.equal(options.find(option => option.value === '1001').label, 'Game player #1001');
    assert(options.every(option => option.label.length > 0 && option.label.length <= 100));
    const open = interaction('dw:ignore'); await ui.handle(open);
    assert.deepEqual(open.calls, ['deferUpdate', 'editReply']);
  } finally { s.cleanup(); }
});

test('Discord rejecting the ignored-player dropdown falls back to working ID buttons without blaming admin privileges', async () => {
  const s = setup();
  try {
    observe(s.state, '700001', 200);
    const ui = panel(s), logs = []; ui.log = line => logs.push(line);
    const open = interaction('dw:ignore'), save = open.editReply;
    open.editReply = async payload => {
      await save(payload);
      if (payload.components?.some(row => row.components.some(component => component.custom_id?.startsWith('dw:ignoreSelect:')))) {
        throw Object.assign(new Error('Invalid Form Body'), { code: 50035,
          requestBody: { token: 'DO_NOT_LOG_TOKEN' }, rawError: { errors: { components: { 0: { components: { 0: { options: { _errors: [{ code: 'BASE_TYPE_BAD_LENGTH', message: 'DO_NOT_LOG_TOKEN' }] } } } } } } } });
      }
    };
    await ui.handle(open);
    const fallback = open.replies.at(-1);
    assert(fallback.content.includes('still manage exclusions')); assert(!fallback.content.includes('Check channel permissions'));
    assert(fallback.components.flatMap(row => row.components).some(button => button.custom_id === 'dw:ignoreIds'));
    assert(fallback.components.flatMap(row => row.components).every(component => component.type !== 3));
    for (const row of fallback.components) require('discord.js').ActionRowBuilder.from(row).toJSON();
    assert(logs[0].includes('code=50035')); assert(logs[0].includes('components.0.components.0.options'));
    assert(!logs.join('\n').includes('DO_NOT_LOG_TOKEN'));
  } finally { s.cleanup(); }
});

test('queued, delivered and uncertain outbox records stop resends even if the alert ledger is missing', () => {
  for (const status of ['queued', 'delivered', 'uncertain', 'failed', 'cancelled']) {
    const s = setup();
    try {
      s.settings.update(s.rule.id, s.rule.revision, { occurrences: 1, upper: null });
      observe(s.state, '700001', 200);
      const original = evaluate(s.state, s.settings, 1000)[0]; original.status = status;
      runtime(s.state).alerted = {};
      const before = JSON.stringify(s.state.outbox);
      assert.equal(evaluate(s.state, s.settings, 2000).length, 0); assert.equal(JSON.stringify(s.state.outbox), before);
      observe(s.state, '700001', 400); assert.equal(evaluate(s.state, s.settings, 3000).length, 0);
    } finally { s.cleanup(); }
  }
});

test('combined upper/count records recover legacy dedup keys, while a new monster can still trigger H', () => {
  const s = setup();
  try {
    s.settings.update(s.rule.id, s.rule.revision, { occurrences: 1 });
    observe(s.state, '700001', 600); const first = evaluate(s.state, s.settings, 1000)[0];
    assert(first.countTriggered && first.upperTriggered); delete first.dedupKeys; first.status = 'delivered';
    runtime(s.state).alerted = {};
    assert.equal(evaluate(s.state, s.settings, 2000).length, 0);
    observe(s.state, '700002', 600);
    const next = evaluate(s.state, s.settings, 3000);
    assert.equal(next.length, 1); assert(next[0].upperTriggered); assert.equal(next[0].countTriggered, false);
    assert(next[0].dedupKeys.some(key => key.endsWith(':700002')));
  } finally { s.cleanup(); }
});

test('multiple combined H keys survive restart and evidence truncation', () => {
  const s = setup();
  try {
    observe(s.state, '700001', 600); observe(s.state, '700002', 600); observe(s.state, '700003', 600);
    const first = evaluate(s.state, s.settings, 1000)[0];
    assert.equal(first.dedupKeys.length, 4); first.status = 'delivered'; first.evidence = [];
    const restored = JSON.parse(JSON.stringify(s.state)); restored.watcher.alerted = {};
    assert.equal(evaluate(restored, s.settings, 2000).length, 0);
  } finally { s.cleanup(); }
});

test('full scan/publish cycles drain different-player alerts once, with no repeated reference after restart', async () => {
  const s = setup();
  try {
    s.settings.update(s.rule.id, s.rule.revision, { threshold: '10000000', occurrences: 1, upper: null });
    const location = fixture('dungeon_location_shadowbridge.html').replaceAll('Vorga Ash-Shaman', 'Gribble Junk-Magus');
    const snapshot = { owner: 'owner', observedAt: 1000, warnings: [], instances: [{
      ...s.state.instances['800001'], rooms: [], locations: [{ instanceId: '800001', locationId: '1', name: 'brood pits',
        url: '/guild_dungeon_location.php?instance_id=800001&location_id=1' }],
    }] };
    const scanner = { session: { owner: () => 'owner' }, scan: async () => snapshot, reader: { get: async url => ({
      body: String(url).startsWith('/battle.php') ? html.replace('dgmid: 700001', 'dgmid: ' + new URL(url, 'https://demonicscans.org').searchParams.get('dgmid')) : location,
    }) } };
    const store = { state: s.state, save() {} }, posted = [];
    const publisher = new DiscordPublisher({ channelId: '333', applicationId: '111', announcements: true, dashboard: false }, store, {
      token: 'mock', fetcher: async (_, request) => { posted.push(JSON.parse(request.body)); return new Response(JSON.stringify({ id: String(900000 + posted.length) })); },
    });
    publisher.watcherSettings = s.settings;
    const monitor = new Monitor(scanner, store, publisher, { pollSeconds: 60, watcherReadBudget: 3 }, () => {});
    monitor.watcher = new DamageWatcher(scanner, store, s.settings, { pollSeconds: 60, watcherReadBudget: 3 }, () => 1000);
    for (let i = 0; i < 5; i++) await monitor.cycle();
    const expected = inspectLeaderboard(html, { instanceId: '800001', monsterId: '700001' }).players.filter(player => BigInt(player.damage) > 10000000n).length;
    assert.equal(posted.length, expected);
    assert.equal(new Set(posted.map(payload => payload.embeds[0].footer.text)).size, expected);
    assert.equal(new Set(posted.map(payload => payload.embeds[0].title)).size, expected);
    store.state = JSON.parse(JSON.stringify(store.state)); store.state.watcher.alerted = {};
    monitor.watcher = new DamageWatcher(scanner, store, s.settings, { pollSeconds: 60, watcherReadBudget: 3 }, () => 2000);
    await monitor.cycle(); assert.equal(posted.length, expected);
  } finally { s.cleanup(); }
});

test('alert cards expose player ID, battle ID and a stable reference for identifying exact repeats', () => {
  const s = setup();
  try {
    const event = evaluateAfterHit(s), payload = alertPayload(event);
    assert(payload.embeds[0].title.includes('#1001')); assert(payload.embeds[0].fields[1].value.includes('Battle #700001'));
    assert(payload.embeds[0].description.includes('Test rule'));
    assert.equal(payload.embeds[0].footer.text, alertPayload(event).embeds[0].footer.text);
    require('discord.js').EmbedBuilder.from(payload.embeds[0]).toJSON();
  } finally { s.cleanup(); }
});
