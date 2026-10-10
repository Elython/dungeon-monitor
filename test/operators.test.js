const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { OperatorSettings } = require('../src/operatorSettings');
const { CommandHandler } = require('../src/commands');
const { TemplateStore } = require('../src/templates');
const { DiscordPublisher } = require('../src/discord');
const { BotRuntime } = require('../src/bot');
const { emptyState } = require('../src/storage');

const config = { applicationId: '111', guildId: '222', channelId: '333', dashboard: true, announcements: true };
function temporary() { return fs.mkdtempSync(path.join(os.tmpdir(), 'dungeon-operators-test-')); }
function interaction(command, action, { admin = true, type = 'boss_opened', target = 'none', roleId, channelId = '444', ping = false } = {}) {
  const replies = [];
  return { commandName: command, guildId: '222', isChatInputCommand: () => true, memberPermissions: { has: () => admin }, replies,
    options: { getSubcommand: () => action, getString: key => key === 'type' ? type : key === 'target' ? target : null,
      getRole: () => roleId ? { id: roleId } : null, getChannel: () => ({ id: channelId }), getBoolean: () => ping },
    reply: async value => { replies.push(value); }, deferReply: async value => { replies.push(value); }, editReply: async value => { replies.push(value); } };
}

test('channel and per-type mentions persist independently and stay server-scoped', () => {
  const directory = temporary();
  try {
    const file = path.join(directory, 'settings.json'); const settings = new OperatorSettings(file, config);
    assert.equal(settings.channelId(), '333'); assert.equal(settings.mention('opened').kind, 'none');
    settings.setChannel('444'); settings.setMention('boss_opened', { kind: 'role', roleId: '555' });
    settings.setMention('opened', { kind: 'everyone' });
    const restored = new OperatorSettings(file, config);
    assert.equal(restored.channelId(), '444'); assert.equal(restored.mention('boss_opened').roleId, '555');
    assert.equal(restored.mention('closed').kind, 'none');
    assert.throws(() => new OperatorSettings(file, { ...config, guildId: 'other' }), /another server/);
    const payload = { content: 'Message', allowed_mentions: { parse: [] } };
    const role = settings.decorate('boss_opened', payload); assert.equal(role.content, '<@&555>\nMessage');
    assert.deepEqual(role.allowed_mentions, { parse: [], users: [], roles: ['555'] });
    const everyone = settings.decorate('opened', payload); assert(everyone.content.startsWith('@everyone\n'));
    assert.deepEqual(everyone.allowed_mentions.parse, ['everyone']);
    assert.deepEqual(settings.decorate('opened', payload, false).allowed_mentions.parse, []);
    settings.setMention('opened', { kind: 'none' }); assert.equal(settings.decorate('opened', payload).content, 'Message');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('failed settings writes cannot activate an unsaved channel or mass ping', () => {
  const directory = temporary();
  try {
    const settings = new OperatorSettings(path.join(directory, 'settings.json'), config);
    const blocked = path.join(directory, 'blocked'); fs.mkdirSync(blocked); settings.file = blocked;
    assert.throws(() => settings.setChannel('444'));
    assert.equal(settings.channelId(), '333');
    assert.throws(() => settings.setMention('opened', { kind: 'everyone' }));
    assert.equal(settings.mention('opened').kind, 'none');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('operator channel and ping changes validate permissions before saving', async () => {
  const directory = temporary();
  try {
    const settings = new OperatorSettings(path.join(directory, 'settings.json'), config);
    const templates = new TemplateStore(path.join(directory, 'templates.json'), 'test');
    const state = { state: emptyState(), save() {} }; let calls = [];
    const publisher = new DiscordPublisher(config, state, { token: 'mock', templates, settings, fetcher: async url => {
      calls.push(url.pathname); return new Response('{"id":"123456"}', { status: 200 });
    } });
    const handler = new CommandHandler({ config, settings, templates, publisher, monitor: { store: state },
      validateChannel: async id => { if (id !== '444') throw new Error('Choose a channel in this server'); },
      validateMention: async rule => { if (rule.kind === 'everyone') throw new Error('The bot needs mention permission'); } });
    await handler.handle(interaction('channel', 'set', { admin: false })); assert.equal(settings.channelId(), '333');
    await handler.handle(interaction('channel', 'set', { channelId: 'wrong' })); assert.equal(settings.channelId(), '333');
    await handler.handle(interaction('channel', 'set')); assert.equal(settings.channelId(), '444');
    assert(calls[0].includes('/channels/444/messages'));
    await handler.handle(interaction('mentions', 'set', { target: 'everyone' })); assert.equal(settings.mention('boss_opened').kind, 'none');
    await handler.handle(interaction('mentions', 'set', { target: 'role', roleId: '555' })); assert.equal(settings.mention('boss_opened').roleId, '555');
    await handler.handle(interaction('mentions', 'reset')); assert.equal(settings.mention('boss_opened').kind, 'none');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('configured pings affect new messages, edits remain silent, and tests require explicit ping', async () => {
  const directory = temporary();
  try {
    const settings = new OperatorSettings(path.join(directory, 'settings.json'), config); settings.setMention('dashboard', { kind: 'everyone' }); settings.setMention('boss_opened', { kind: 'role', roleId: '555' });
    const templates = new TemplateStore(path.join(directory, 'templates.json'), 'test'); const state = { state: emptyState(), save() {} }; const calls = [];
    const publisher = new DiscordPublisher(config, state, { token: 'mock', templates, settings, fetcher: async (_, request) => {
      calls.push({ method: request.method, ...JSON.parse(request.body) }); return new Response('{"id":"123456"}', { status: 200 });
    } });
    await publisher.sendTest('boss_opened'); assert.deepEqual(calls.at(-1).allowed_mentions.roles, []);
    await publisher.sendTest('boss_opened', undefined, { ping: true }); assert.deepEqual(calls.at(-1).allowed_mentions.roles, ['555']);
    await publisher.publish(); assert.deepEqual(calls.at(-1).allowed_mentions.parse, ['everyone']);
    state.state.health = { status: 'error', detail: 'Test' }; await publisher.publish();
    assert.equal(calls.at(-1).method, 'PATCH'); assert.deepEqual(calls.at(-1).allowed_mentions.parse, []);
    assert.deepEqual(calls.at(-1).allowed_mentions.roles, []);
    await publisher.changeChannel('444'); await publisher.publish(undefined, { dashboardOnly: true });
    assert.equal(calls.at(-1).method, 'POST'); assert.equal(state.state.dashboard.identity, 'bot:111:444');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('Discord validation checks destination guild and required channel/mention permissions', async () => {
  let allowMention = false; let mentionable = false;
  const channel = { type: 0, guildId: '222', permissionsFor: () => ({ has: bit => bit === 131072n ? allowMention : true }),
    guild: { roles: { fetch: async id => ({ id, mentionable }) } } };
  const runtime = { config, client: { user: {}, channels: { fetch: async () => channel } }, publisher: { channelId: () => '333' } };
  Object.setPrototypeOf(runtime, BotRuntime.prototype);
  await runtime.validateChannel('333');
  await assert.rejects(runtime.validateMention({ kind: 'everyone' }), /Mention @everyone/);
  await assert.rejects(runtime.validateMention({ kind: 'role', roleId: '555' }), /mentionable/);
  mentionable = true; await runtime.validateMention({ kind: 'role', roleId: '555' });
  allowMention = true; await runtime.validateMention({ kind: 'everyone' });
  channel.guildId = 'wrong'; await assert.rejects(runtime.validateChannel('333'), /this server/);
});

test('tests default to silent DMs with configured mentions; public ping tests are explicit', async () => {
  const directory = temporary();
  try {
    const settings = new OperatorSettings(path.join(directory, 'settings.json'), config);
    settings.setMention('boss_opened', { kind: 'role', roleId: '555' });
    const templates = new TemplateStore(path.join(directory, 'templates.json'), 'test');
    let publicPosts = 0; let validations = 0; const dms = [];
    const handler = new CommandHandler({ config, settings, templates,
      publisher: { sendTest: async (_, __, options) => { publicPosts++; assert.equal(options.ping, true); return { status: 'delivered' }; } },
      validateMention: async () => { validations++; } });
    const make = (destination, ping = false) => {
      const item = interaction('test', undefined, { ping });
      item.options.getString = key => key === 'type' ? 'boss_opened' : destination;
      item.user = { send: async payload => { dms.push(payload); } };
      return item;
    };
    const privateTest = make(null); await handler.handle(privateTest);
    assert.equal(dms.length, 1); assert(dms[0].content.includes('<@&555>'));
    assert.deepEqual(dms[0].allowedMentions, { parse: [], users: [], roles: [] });
    assert.equal(publicPosts, 0); assert.equal(validations, 0);
    await handler.handle(make(null, true)); assert.equal(dms.length, 1); assert.equal(publicPosts, 0);
    const blocked = make(null); blocked.user.send = async () => { throw new Error('DM blocked'); };
    await handler.handle(blocked); assert(blocked.replies.at(-1).content.includes('/messages preview')); assert.equal(publicPosts, 0);
    await handler.handle(make('channel', true)); assert.equal(publicPosts, 1); assert.equal(validations, 1);
    const preview = interaction('messages', 'preview'); await handler.handle(preview);
    assert(preview.replies.at(-1).content.includes('<@&555>'));
    assert.deepEqual(preview.replies.at(-1).allowedMentions, { parse: [] });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('multiple role rules migrate, persist, deduplicate and restrict all ping recipients', async () => {
  const directory = temporary();
  try {
    const file = path.join(directory, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, owner: '111:222', channelId: null,
      mentions: { opened: { kind: 'role', roleId: '555' } } }));
    const settings = new OperatorSettings(file, config);
    assert.deepEqual(settings.mention('opened').roleIds, ['555']);
    let validated;
    const handler = new CommandHandler({ config, settings,
      publisher: { changeMention: async (type, rule) => settings.setMention(type, rule) },
      validateMention: async rule => { validated = rule.roleIds; } });
    const command = interaction('mentions', 'set', { target: 'role', roleId: '555' });
    command.options.getString = key => ({ type: 'boss_opened', target: 'role', roles: '<@&666> 777,555' })[key];
    await handler.handle(command);
    assert.deepEqual(validated, ['555', '666', '777']);
    const restored = new OperatorSettings(file, config);
    const payload = restored.decorate('boss_opened', { content: 'Boss opened' });
    assert.equal(payload.content, '<@&555> <@&666> <@&777>\nBoss opened');
    assert.deepEqual(payload.allowed_mentions.roles, ['555', '666', '777']);
    assert.deepEqual(restored.decorate('boss_opened', { content: 'Preview' }, false).allowed_mentions.roles, []);
    assert(restored.describe('boss_opened').includes('<@&777>'));
    command.options.getString = key => ({ type: 'boss_opened', target: 'role', roles: '@unresolved' })[key];
    await handler.handle(command);
    assert(command.replies.at(-1).content.includes('Choose roles'));
    assert.deepEqual(settings.mention('boss_opened').roleIds, ['555', '666', '777']);
    assert.throws(() => settings.setMention('opened', { kind: 'role', roleIds: [] }), /1 and 25/);
    handler.verifyMention = async () => { throw new Error('Make that role mentionable'); };
    command.options.getString = key => ({ type: 'boss_opened', target: 'role', roles: '888' })[key];
    await handler.handle(command);
    assert.deepEqual(settings.mention('boss_opened').roleIds, ['555', '666', '777']);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('all roles are checked against the destination permissions', async () => {
  const fetched = [];
  const channel = { permissionsFor: () => ({ has: () => false }),
    guild: { roles: { fetch: async id => { fetched.push(id); return { id, mentionable: id === '555' }; } } } };
  const runtime = { config, client: { user: {} }, publisher: { channelId: () => '333' }, validateChannel: async () => channel };
  await assert.rejects(BotRuntime.prototype.validateMention.call(runtime, { kind: 'role', roleIds: ['555', '666'] }), /mentionable/);
  assert.deepEqual(fetched, ['555', '666']);
});
