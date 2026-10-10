const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { TemplateStore, validateTemplate } = require('../src/templates');
const { CommandHandler, COMMANDS } = require('../src/commands');
const { DiscordPublisher } = require('../src/discord');
const { Monitor } = require('../src/monitor');
const { inviteLink, registerCommands } = require('../src/bot');
const { emptyState } = require('../src/storage');

function temporary() { return fs.mkdtempSync(path.join(os.tmpdir(), 'dungeon-bot-test-')); }
function store() { return { state: emptyState(), save() {} }; }
function interaction(name, { guildId = '123', admin = false, type = 'opened', action = 'show', text = '', destination = 'private' } = {}) {
  const replies = [];
  return { commandName: name, guildId, memberPermissions: { has: bit => admin && bit === 32n },
    isChatInputCommand: () => true, options: { getString: name => name === 'type' ? type : name === 'destination' ? destination : text, getSubcommand: () => action }, replies,
    reply: async payload => { replies.push(payload); }, deferReply: async payload => { replies.push(payload); }, editReply: async payload => { replies.push(payload); } };
}

test('message templates persist by server and substitute bounded fields without evaluating code', () => {
  const directory = temporary();
  try {
    const file = path.join(directory, 'templates.json'); const templates = new TemplateStore(file, 'bot:app:server');
    templates.set('boss_opened', '**Boss unlocked: {name}**\\n{room}\\n{url}\\n{time}');
    const output = templates.preview('boss_opened', 1000);
    assert(output.content.includes('\nExample Boss Room\n')); assert(output.content.includes('<t:1:f>'));
    assert.deepEqual(output.allowed_mentions.parse, []);
    assert.equal(new TemplateStore(file, 'bot:app:server').get('boss_opened'), templates.get('boss_opened'));
    assert.throws(() => new TemplateStore(file, 'another-server'), /another Discord/);
    assert.throws(() => validateTemplate('opened', '{token}'), /Unsupported placeholder/);
    assert.throws(() => validateTemplate('dashboard', '{name}'), /Unsupported placeholder/);
    assert.throws(() => validateTemplate('opened', 'x'.repeat(1501)), /1,500/);
    templates.reset('boss_opened'); assert(templates.get('boss_opened').includes('Boss room opened'));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('status/ping are private; other-server and non-admin mutations are rejected', async () => {
  let scans = 0; let posts = 0; let edits = 0;
  const handler = new CommandHandler({ config: { guildId: '123' }, monitor: { store: store(), cycle: async () => { scans++; } },
    publisher: { sendTest: async () => { posts++; }, publish: async () => {} },
    templates: { dashboard: () => ({ content: 'Current status' }), set: () => { edits++; } } });
  const ping = interaction('ping'); await handler.handle(ping);
  assert.equal(ping.replies[0].flags, 64); assert(ping.replies.at(-1).content.includes('Pong'));
  const status = interaction('status'); await handler.handle(status); assert(status.replies.at(-1).content.includes('Current status'));
  for (const name of ['refresh', 'test', 'messages', 'channel', 'mentions']) {
    const rejected = interaction(name); await handler.handle(rejected); assert(rejected.replies[0].content.includes('Manage Server'));
  }
  const otherGuild = interaction('messages', { guildId: 'wrong', admin: true }); await handler.handle(otherGuild);
  assert(otherGuild.replies[0].content.includes('another server'));
  assert.equal(scans, 0); assert.equal(posts, 0); assert.equal(edits, 0);
});

test('admin edits and resets future formatting; preview does not send, dashboard updates only itself', async () => {
  const directory = temporary();
  try {
    const templates = new TemplateStore(path.join(directory, 'templates.json'), 'test'); let published = 0; let tests = 0;
    const handler = new CommandHandler({ config: { guildId: '123' }, monitor: { store: store() }, templates,
      publisher: { publish: async (_, options) => { assert.equal(options.dashboardOnly, true); published++; }, sendTest: async () => { tests++; return { status: 'delivered' }; } } });
    await handler.handle(interaction('messages', { admin: true, action: 'set', text: 'Opened: {name}\\n{url}' }));
    assert.equal(templates.get('opened'), 'Opened: {name}\n{url}'); assert.equal(published, 0);
    const preview = interaction('messages', { admin: true, action: 'preview' }); await handler.handle(preview);
    assert(preview.replies.at(-1).content.includes('PRIVATE PREVIEW')); assert.equal(tests, 0);
    await handler.handle(interaction('messages', { admin: true, action: 'set', type: 'dashboard', text: '{health}Guild dungeons:\\n{dungeons}{lastScan}' }));
    assert.equal(published, 1);
    await handler.handle(interaction('messages', { admin: true, action: 'reset' })); assert(templates.get('opened').includes('Dungeon opened'));
    await handler.handle(interaction('test', { admin: true, destination: 'channel' })); assert.equal(tests, 1);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('manual refresh is bounded and polling/manual scans share the same work', async () => {
  let scans = 0; let finish;
  const pending = new Promise(resolve => { finish = resolve; }); const data = store();
  const monitor = new Monitor({ scan: async () => { scans++; await pending; return { owner: 'test', instances: [], warnings: [], observedAt: 1000 }; } }, data, { publish: async () => {} }, { missingConfirmations: 2 }, () => {});
  const left = monitor.cycle(); const right = monitor.cycle(); assert.equal(left, right); finish(); await left; assert.equal(scans, 1);
  let now = 1000;
  const handler = new CommandHandler({ config: { guildId: '123' }, monitor, publisher: {}, templates: { dashboard: () => ({ content: 'Status' }) }, now: () => now });
  await handler.handle(interaction('refresh', { admin: true })); assert.equal(scans, 2);
  const second = interaction('refresh', { admin: true }); await handler.handle(second); assert.equal(scans, 2); assert(second.replies.at(-1).content.includes('one minute'));
  now += 60000; await handler.handle(interaction('refresh', { admin: true })); assert.equal(scans, 3);
});

test('bot delivery uses channel REST with authentication, labelled tests do not change game history', async () => {
  const directory = temporary();
  try {
    const templates = new TemplateStore(path.join(directory, 'templates.json'), 'test'); const data = store(); let calls = [];
    const publisher = new DiscordPublisher({ applicationId: '1', guildId: '123', channelId: '456', announcements: true, dashboard: true }, data,
      { token: 'private-test-token', templates, fetcher: async (url, request) => {
        assert.equal(url.origin, 'https://discord.com'); assert(url.pathname.startsWith('/api/v10/channels/456/messages'));
        assert.equal(request.headers.Authorization, 'Bot private-test-token');
        const body = JSON.parse(request.body); assert.equal(body.username, undefined); assert.deepEqual(body.allowed_mentions.parse, []);
        calls.push({ method: request.method, content: body.content }); return new Response('{"id":"789"}', { status: 200 });
      } });
    const before = JSON.stringify(data.state);
    const result = await publisher.sendTest('boss_opened'); assert.equal(result.status, 'delivered');
    assert(calls[0].content.includes('TEST — not a real dungeon event')); assert.equal(JSON.stringify(data.state), before);
    await publisher.publish(); assert.equal(data.state.dashboard.identity, 'bot:1:456');
    templates.set('dashboard', 'New layout:\\n{dungeons}{lastScan}');
    await publisher.publish(undefined, { dashboardOnly: true }); assert.equal(calls.at(-1).method, 'PATCH');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('command definitions expose only requested monitoring functions and scope permissions', () => {
  assert.deepEqual(COMMANDS.map(command => command.name), ['ping', 'status', 'refresh', 'test', 'channel', 'mentions', 'messages', 'watcher']);
  for (const command of COMMANDS.filter(command => ['refresh', 'test', 'messages', 'channel', 'mentions'].includes(command.name))) assert.equal(command.default_member_permissions, '32');
  for (const command of COMMANDS) assert(command.description.length <= 100);
});


test('invitation contains minimal scopes and command registration upserts names without deleting other commands', async () => {
  const config = { applicationId: '111', guildId: '222', channelId: '333' };
  const invite = new URL(inviteLink(config));
  assert.equal(invite.origin, 'https://discord.com');
  assert.equal(invite.searchParams.get('scope'), 'bot applications.commands');
  assert.equal(invite.searchParams.get('permissions'), '84992');
  assert.equal(invite.searchParams.get('guild_id'), '222');
  const calls = [];
  class REST {
    constructor(options) { assert.equal(options.retries, 0); }
    setToken(value) { assert.equal(value, 'mock-token'); return this; }
    async post(route, options) { calls.push(options.body.name); assert.equal(route, '111/222'); }
  }
  await registerCommands(config, { sdkProvider: () => ({ REST, Routes: { applicationGuildCommands: (app, guild) => app + '/' + guild } }), env: { DISCORD_BOT_TOKEN: 'mock-token' } });
  assert.deepEqual(calls, ['ping', 'status', 'refresh', 'test', 'channel', 'mentions', 'messages', 'watcher']);
});

test('operator roles grant command access without Manage Server for cached and raw members', async () => {
  let saves = 0;
  const handler = new CommandHandler({ config: { guildId: '123', operatorRoleIds: ['555'] },
    templates: { set: () => { saves++; }, preview: () => ({ content: 'Preview' }) }, publisher: {} });
  for (const roles of [['555'], { cache: new Map([['555', {}]]) }]) {
    const allowed = interaction('messages', { action: 'set', text: 'Custom' });
    allowed.member = { roles }; await handler.handle(allowed);
    assert(allowed.replies.at(-1).content.includes('Saved'));
  }
  for (const roles of [undefined, ['999'], { cache: new Map([['999', {}]]) }]) {
    const denied = interaction('messages', { action: 'set' }); denied.member = { roles };
    await handler.handle(denied); assert(denied.replies[0].content.includes('operator role'));
  }
  const wrongServer = interaction('messages', { action: 'set', guildId: 'wrong' });
  wrongServer.member = { roles: ['555'] }; await handler.handle(wrongServer);
  assert(wrongServer.replies[0].content.includes('another server'));
  assert.equal(saves, 2);
});

test('role-enabled registration clears Discord Manage Server restriction', async () => {
  const commands = [];
  class REST { setToken() { return this; } async post(_, { body }) { commands.push(body); } }
  await registerCommands({ applicationId: '111', guildId: '222', channelId: '333', operatorRoleIds: ['555'] },
    { sdkProvider: () => ({ REST, Routes: { applicationGuildCommands: () => 'route' } }), env: { DISCORD_BOT_TOKEN: 'mock' } });
  assert.equal(commands.find(command => command.name === 'messages').default_member_permissions, null);
  assert.equal(COMMANDS.find(command => command.name === 'messages').default_member_permissions, '32');
});

test('operator role configuration accepts quoted IDs and rejects malformed lists', () => {
  const { loadConfig } = require('../src/config'); const directory = temporary();
  try {
    const file = path.join(directory, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ discord: { operatorRoleIds: ['555', '555'] } }));
    assert.deepEqual(loadConfig(file).discord.operatorRoleIds, ['555']);
    for (const invalid of [['name'], [555], '555']) {
      fs.writeFileSync(file, JSON.stringify({ discord: { operatorRoleIds: invalid } }));
      assert.throws(() => loadConfig(file), /operatorRoleIds/);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
