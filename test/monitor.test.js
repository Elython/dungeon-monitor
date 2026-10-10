const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { emptyState, StateStore } = require('../src/storage');
const { reduceSnapshot } = require('../src/model');
const { inspectDirectory, inspectRoom, inspectLockedBossPins, DungeonScanner } = require('../src/scanner');
const { GameReader, safeGameUrl, isChallengeResponse } = require('../src/transport');
const { DiscordPublisher } = require('../src/discord');
const { Monitor } = require('../src/monitor');
const { Session, importSession } = require('../src/session');
const { loadConfig } = require('../src/config');
const { acquireLock } = require('../src/cli');

function fixture(name) { return fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'); }
const room = status => ({ id: 'location:5', name: 'Boss Room', status, url: '/guild_dungeon_location.php?instance_id=800001&location_id=5' });
const instance = (id = '800001', status = 'active', boss = 'locked') => ({ instanceId: id, name: 'Shadowbridge Warrens', status,
  active: status === 'active', url: '/guild_dungeon_enter.php?id=' + id, rooms: [room(boss)] });
const snapshot = (instances, observedAt = 1000, owner = 'test') => ({ owner, instances, observedAt, warnings: [] });
function memoryStore(state = emptyState()) { return { state, saves: 0, save() { this.saves++; } }; }

test('verified directory/room fixtures and strict malformed-page handling', () => {
  const rows = inspectDirectory(fixture('guild_dungeon_index.html'));
  assert.equal(rows.filter(row => row.active).length, 2);
  assert(rows.some(row => row.status === 'failed'));
  assert(rows.some(row => row.status === 'cleared'));
  assert.throws(() => inspectDirectory('<title>Login</title>'), /not fully recognized/);
  const incomplete = fixture('guild_dungeon_index.html').replace('Shadowbridge Warrens</div>', '</div>');
  assert.throws(() => inspectDirectory(incomplete), /not fully recognized/);
  const context = { dungeonName: 'Shadowbridge Warrens', instanceId: '800001', locationName: 'brood pits', locationId: '1', boss: true };
  assert.equal(inspectRoom(fixture('dungeon_location_shadowbridge.html'), context).status, 'open');
  assert.equal(inspectRoom(fixture('boss_room_locked.html'), { ...context, locationName: 'Boss Room' }).status, 'locked');
  assert.equal(inspectRoom('<html>Random page</html>', context).status, 'unknown');
  assert.equal(inspectRoom(fixture('dungeon_location_shadowbridge.html'), { ...context, instanceId: 'wrong' }).status, 'unknown');
});

test('baseline, dungeon lifecycle, boss unlock, same-name rollover and deduplication', () => {
  const state = emptyState();
  assert.equal(reduceSnapshot(state, snapshot([instance()])).length, 0);
  assert.equal(reduceSnapshot(state, snapshot([instance('800001', 'active', 'open')], 2000))[0].type, 'boss_opened');
  assert.equal(reduceSnapshot(state, snapshot([instance('800001', 'active', 'open')], 3000)).length, 0);
  const changed = reduceSnapshot(state, snapshot([instance('800001', 'cleared', 'cleared'), instance('800002')], 4000));
  assert.deepEqual(changed.map(event => event.type), ['closed', 'opened']);
  assert.equal(reduceSnapshot(state, snapshot([instance('800001', 'cleared', 'cleared'), instance('800002')], 5000)).length, 0);
  const priorEvents = Object.keys(state.outbox).length;
  reduceSnapshot(state, snapshot([instance('900001', 'active', 'open')], 6000, 'different-account'));
  assert.equal(Object.keys(state.outbox).length, 0);
  assert(priorEvents > 0);
});

test('missing instance needs multiple verified directory reads, failed scans never close it', async () => {
  const store = memoryStore(); reduceSnapshot(store.state, snapshot([instance()]));
  assert.equal(reduceSnapshot(store.state, snapshot([], 2000)).length, 0);
  const monitor = new Monitor({ scan: async () => { throw new Error('Temporary server error'); } }, store, { publish: async () => {} }, {} , () => {});
  await monitor.cycle(new AbortController().signal);
  assert.equal(store.state.instances['800001'].active, true);
  assert.equal(reduceSnapshot(store.state, snapshot([], 4000))[0].type, 'closed');
});

test('unknown boss reads retain prior evidence without inventing unlocks', () => {
  const state = emptyState(); reduceSnapshot(state, snapshot([instance()]));
  assert.equal(reduceSnapshot(state, snapshot([instance('800001', 'active', 'unknown')], 2000)).length, 0);
  assert.equal(state.instances['800001'].rooms['location:5'].confirmed, 'locked');
  assert.equal(reduceSnapshot(state, snapshot([instance('800001', 'active', 'open')], 3000))[0].type, 'boss_opened');
});

test('persistent sending state becomes uncertain after restart, without reposting', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dungeon-monitor-test-'));
  try {
    const store = new StateStore(path.join(directory, 'state.json'));
    reduceSnapshot(store.state, snapshot([instance()]));
    reduceSnapshot(store.state, snapshot([instance('800001', 'active', 'open')], 2000));
    const event = Object.values(store.state.outbox)[0]; event.status = 'sending'; store.save();
    const restarted = new StateStore(store.file);
    assert.equal(Object.values(restarted.state.outbox)[0].status, 'uncertain');
    let sends = 0;
    const publisher = new DiscordPublisher({ announcements: true, dashboard: false, applicationId: '1', channelId: '456' }, restarted,
      { token: 'mock-token', fetcher: async () => { sends++; throw new Error('Must not retry'); } });
    await publisher.publish(); assert.equal(sends, 0);
    assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('Discord confirmation, mentions, rate limit and ambiguous-send behavior', async () => {
  const store = memoryStore(); reduceSnapshot(store.state, snapshot([instance()]));
  reduceSnapshot(store.state, snapshot([instance('800001', 'active', 'open')], 2000));
  const config = { applicationId: '1', channelId: '456', dashboard: false, announcements: true };
  let calls = 0;
  const publisher = new DiscordPublisher(config, store, { token: 'mock-token', now: () => 10000, log() {}, fetcher: async (url, request) => {
    calls++; assert.equal(new URL(url).pathname, '/api/v10/channels/456/messages');
    assert.deepEqual(JSON.parse(request.body).allowed_mentions.parse, []);
    return new Response(JSON.stringify({ retry_after: 3 }), { status: 429 });
  } });
  await publisher.publish(); const event = Object.values(store.state.outbox)[0];
  assert.equal(event.status, 'queued'); assert.equal(event.retryAt, 13000);
  await publisher.publish(); assert.equal(calls, 1);
  publisher.now = () => 14000;
  publisher.fetcher = async () => { throw new Error('Private bot token in an underlying error'); };
  await publisher.publish(); assert.equal(event.status, 'uncertain'); assert(!event.error.includes('mock-token'));
  await publisher.publish(); assert.equal(calls, 1);
  event.status = 'queued'; delete event.retryAt;
  publisher.fetcher = async () => new Response(JSON.stringify({ id: '123456' }), { status: 200 });
  await publisher.publish(); assert.equal(event.status, 'delivered');
});

test('dashboard edits existing message and never creates an uncertain duplicate', async () => {
  const store = memoryStore(); reduceSnapshot(store.state, snapshot([instance()]));
  let calls = [];
  const publisher = new DiscordPublisher({ announcements: false, dashboard: true, applicationId: '1', channelId: '456' }, store,
    { token: 'mock-token', fetcher: async (url, options) => { calls.push(options.method); return new Response('{"id":"555"}', { status: 200 }); } });
  await publisher.publish(); await publisher.publish(); assert.deepEqual(calls, ['POST']);
  store.state.lastScanAt++;
  await publisher.publish(); assert.equal(calls.length, 1, 'Same displayed timestamp does not rewrite identical content');
  store.state.lastScanAt += 1000;
  await publisher.publish(); assert.deepEqual(calls, ['POST', 'PATCH']);
  const uncertain = memoryStore(); uncertain.state.dashboard.uncertain = true;
  const blocked = new DiscordPublisher(publisher.config, uncertain, { token: 'mock-token', fetcher: async () => { throw new Error('Unexpected send'); } });
  await blocked.publish(); assert.equal(uncertain.saves, 0);
});

test('background Cloudflare JavaScript is allowed; real challenge headers and screens remain blocked', async () => {
  const ordinary = fixture('game_page_background_cloudflare.html');
  assert.equal(isChallengeResponse(new Headers(), ordinary), false);
  assert.equal(isChallengeResponse(new Headers({ 'cf-mitigated': 'challenge' }), ordinary), true);
  assert.equal(isChallengeResponse(new Headers(), fixture('cloudflare_challenge.html')), true);
  const session = { userAgent: 'test', header: () => '', applySetCookies() {} };
  const reader = new GameReader(session, { requestGapMilliseconds: 0, requestTimeoutSeconds: 5 },
    async () => new Response(ordinary, { status: 200 }));
  assert.equal((await reader.get('/guild_dungeon.php')).body, ordinary);
  reader.fetcher = async () => new Response('Challenge response', { status: 403, headers: { 'cf-mitigated': 'challenge' } });
  await assert.rejects(reader.get('/guild_dungeon.php'), { code: 'CHALLENGE_REQUIRED' });
});

test('game transport is GET-only, same-origin, recognizes auth/guild/challenge failures', async () => {
  assert.throws(() => safeGameUrl('https://evil.example/guild_dungeon.php'), /rejected/);
  assert.throws(() => safeGameUrl('/damage.php'), /rejected/);
  assert.throws(() => safeGameUrl('/guild_dungeon_enter.php?id=1&action=open'), /parameters/);
  assert.equal(safeGameUrl('/guild_dungeon_instance.php?id=15170').pathname, '/guild_dungeon_instance.php');
  assert.throws(() => safeGameUrl('/guild_dungeon_instance.php'), /locator/);
  assert.throws(() => safeGameUrl('/guild_dungeon_instance.php?id=15170&action=open'), /parameters/);
  assert.throws(() => safeGameUrl('/guild_dungeon_location.php?instance_id=1'), /locator/);
  const session = { userAgent: 'test', header: () => 'private-cookie', applySetCookies() {} };
  const config = { requestGapMilliseconds: 0, requestTimeoutSeconds: 5 };
  const read = new GameReader(session, config, async (url, options) => {
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'manual');
    return new Response('', { status: 302, headers: { location: '/signin.php' } });
  });
  await assert.rejects(read.get('/guild_dungeon.php'), { code: 'AUTH_REQUIRED' });
  read.fetcher = async () => new Response('', { status: 302, headers: { location: '/guild_join_create.php' } });
  await assert.rejects(read.get('/guild_dungeon.php'), { code: 'NOT_IN_GUILD' });
  read.fetcher = async () => new Response('<title>Just a moment</title>', { status: 403 });
  await assert.rejects(read.get('/guild_dungeon.php'), { code: 'CHALLENGE_REQUIRED' });
  read.fetcher = async () => new Response('<div>You are not in a guild yet. Join or create a guild to use Guild Chat.</div><p>normal page</p>');
  assert((await read.get('/guild_dungeon.php')).body.includes('normal page'));
});

test('session import filters origins, rotates cookies, isolates owner and never prints credentials', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dungeon-session-test-'));
  try {
    const har = { log: { entries: [
      { request: { url: 'https://evil.example/', headers: [{ name: 'Cookie', value: 'demon=999' }] } },
      { request: { url: 'https://demonicscans.org/game_dash.php', headers: [{ name: 'User-Agent', value: 'Firefox Test' }, { name: 'Cookie', value: 'demon=123; auth=secret' }] } },
    ] } };
    const source = path.join(directory, 'capture.har'); fs.writeFileSync(source, JSON.stringify(har));
    const file = path.join(directory, 'private/session.json'); importSession(source, file);
    const session = new Session(file); assert(session.header('https://demonicscans.org/game_dash.php').includes('demon=123'));
    assert(!session.owner().includes('123')); assert.equal(session.owner().length, 64);
    assert.throws(() => session.header('https://evil.example/'), /verified game origin/);
    session.applySetCookies(new Headers({ 'set-cookie': 'auth=updated; Path=/; Secure; Max-Age=3600' }));
    assert(session.header('https://demonicscans.org/game_dash.php').includes('auth=updated'));
    const configFile = path.join(directory, 'config.json'); fs.writeFileSync(configFile, '{}');
    const config = loadConfig(configFile);
    assert.equal(Object.hasOwn(config.discord, 'webhookUrl'), false);
    assert.equal(Object.hasOwn(config.discord, 'mode'), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('scanner does not reuse another account and partial room errors preserve dungeon presence', async () => {
  const session = { reloadIfChanged() {}, owner: () => 'test' };
  const reader = { get: async route => {
    if (String(route).includes('game_dash')) return { body: '<div class="small-name">Test</div>' };
    if (String(route).includes('guild_dungeon.php')) return { body: fixture('guild_dungeon_index.html') };
    throw new Error('Room temporarily unavailable');
  } };
  const scanned = await new DungeonScanner(reader, session).scan();
  assert.equal(scanned.instances.filter(row => row.active).length, 2);
  assert.equal(scanned.warnings.length, 2);
  let accountReads = 0; session.owner = () => (++accountReads === 1 ? 'first' : 'second');
  await assert.rejects(new DungeonScanner(reader, session).scan(), { code: 'AUTH_REQUIRED' });
});

test('single-instance lock protects notification state', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dungeon-lock-test-'));
  try {
    const file = path.join(directory, 'state.lock'); const release = acquireLock(file);
    assert.throws(() => acquireLock(file), /already running/); release(); assert.equal(fs.existsSync(file), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('Cube boss alerts use explicit node status, ignoring PvP trials', async () => {
  let status = 'hidden';
  const session = { reloadIfChanged() {}, owner: () => 'cube-test' };
  const index = fixture('guild_dungeon_index.html').replaceAll('Shadowbridge Warrens', 'The Polyhedral Crucible');
  const reader = { get: async route => {
    if (String(route).includes('game_dash')) return { body: '<span class="small-name">Test</span>' };
    if (String(route).includes('guild_dungeon.php')) return { body: index };
    if (String(route).includes('800001')) return { body: fixture('cube_home.html').replace('14543', '800001').replace("status: 'hidden'", "status: '" + status + "'"), url: 'https://demonicscans.org/guild_dungeon_cube.php?instance_id=800001' };
    throw new Error('Other room unavailable');
  } };
  const scanner = new DungeonScanner(reader, session);
  const state = emptyState();
  const first = await scanner.scan();
  assert.equal(first.instances[0].rooms.length, 1); assert.equal(first.instances[0].rooms[0].status, 'locked');
  reduceSnapshot(state, first); status = 'available';
  const events = reduceSnapshot(state, await scanner.scan());
  assert.equal(events.length, 1); assert.equal(events[0].type, 'boss_opened');
});

test('stop prevents later polling, preview never contacts Discord, expired cookies are removed', async () => {
  const controller = new AbortController(); const store = memoryStore(); let scans = 0;
  const publisher = new DiscordPublisher({ enabled: true }, store, { preview: true, log() {}, fetcher: async () => { throw new Error('No Discord call allowed'); } });
  const monitor = new Monitor({ scan: async () => { scans++; controller.abort(); return snapshot([instance()]); } }, store, publisher, { pollSeconds: 120, missingConfirmations: 2 }, () => {});
  await monitor.run(controller.signal); assert.equal(scans, 1);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dungeon-expiry-test-'));
  try {
    const file = path.join(directory, 'session.json');
    fs.writeFileSync(file, JSON.stringify({ userAgent: 'Test', cookies: [{ name: 'demon', value: '123' }] }));
    const session = new Session(file);
    session.applySetCookies(new Headers({ 'set-cookie': 'demon=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT' }));
    assert.throws(() => session.owner(), { code: 'AUTH_REQUIRED' });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('locked boss map pin becomes one open room without guessing a hidden location ID', async () => {
  const locked = inspectLockedBossPins(fixture('shadowbridge_locked_map.html'), 'https://demonicscans.org/guild_dungeon_instance.php?id=15217');
  assert.equal(locked.length, 1); assert.equal(locked[0].name, 'Boss Room'); assert.equal(locked[0].status, 'locked');
  assert(!locked[0].url.includes('location_id'));
  const state = emptyState();
  reduceSnapshot(state, snapshot([{ ...instance('15217'), rooms: locked }]));
  const opened = { ...room('open'), url: '/guild_dungeon_location.php?instance_id=15217&location_id=5' };
  const events = reduceSnapshot(state, snapshot([{ ...instance('15217'), rooms: [opened] }], 2000));
  assert.equal(events.length, 1); assert.equal(events[0].type, 'boss_opened');
  assert.equal(Object.keys(state.instances['15217'].rooms).length, 1);
  assert.equal(state.instances['15217'].rooms['location:5'].status, 'open');
  assert.equal(reduceSnapshot(state, snapshot([{ ...instance('15217'), rooms: [opened] }], 3000)).length, 0);
});

test('ordinary dungeon redirect is followed and missing hidden boss href remains a verified locked room', async () => {
  const directory = fixture('guild_dungeon_index.html').replaceAll('800001', '15217');
  const calls = [];
  const session = { userAgent: 'test', header: () => '', applySetCookies() {}, reloadIfChanged() {}, owner: () => 'test' };
  const reader = new GameReader(session, { requestGapMilliseconds: 0, requestTimeoutSeconds: 5 }, async url => {
    calls.push(new URL(url).pathname);
    if (url.pathname === '/game_dash.php') return new Response('<span class="small-name">Test</span>');
    if (url.pathname === '/guild_dungeon.php') return new Response(directory);
    if (url.pathname === '/guild_dungeon_enter.php') return new Response('', { status: 302, headers: { location: '/guild_dungeon_instance.php?id=' + url.searchParams.get('id') } });
    if (url.searchParams.get('id') === '15217') return new Response(fixture('shadowbridge_locked_map.html'));
    return new Response('Room unavailable', { status: 503 });
  });
  const observed = await new DungeonScanner(reader, session).scan();
  const shadowbridge = observed.instances.find(row => row.instanceId === '15217');
  assert.equal(shadowbridge.rooms.length, 1); assert.equal(shadowbridge.rooms[0].status, 'locked');
  assert(calls.includes('/guild_dungeon_instance.php'));
  assert(!calls.includes('/guild_dungeon_location.php'), 'A disabled JavaScript map link is never followed');
});
