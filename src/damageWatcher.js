const { parseDungeonLocationPage, stripTags } = require('../vendor/dungeonParsers');
const { safeGameUrl } = require('./transport');
const { inspectLeaderboard } = require('./damageParser');
const { setTimeout: sleep } = require('node:timers/promises');

function runtime(state) {
  state.watcher ||= { monsters: {}, players: {}, alerted: {}, health: null, lastScanAt: null };
  return state.watcher;
}
function sameName(a, b) { return String(a).trim().replace(/\s+/g, ' ').toLowerCase() === String(b).trim().replace(/\s+/g, ' ').toLowerCase(); }
function battleKey(instanceId, monsterId) { return instanceId + ':' + monsterId; }
function knownAlertKeys(state) {
  const keys = new Set(Object.keys(runtime(state).alerted));
  // The durable outbox is a second guard: never overwrite an existing send when a ledger entry is missing.
  for (const event of Object.values(state.outbox)) {
    if (event.type !== 'damage_watch') continue;
    keys.add(event.id);
    for (const key of event.dedupKeys || []) keys.add(key);
    if (event.countTriggered) keys.add('damage-count:' + event.ruleId + ':' + event.instanceId + ':' + event.playerId);
    if (event.upperTriggered && event.upper !== null && event.upper !== undefined) {
      for (const monster of event.evidence || []) if (/^\d+$/.test(String(monster.damage)) && /^\d+$/.test(String(event.upper)) && BigInt(monster.damage) >= BigInt(event.upper)) {
        keys.add('damage-upper:' + event.ruleId + ':' + event.instanceId + ':' + event.playerId + ':' + monster.monsterId);
      }
    }
  }
  return keys;
}
function evidence(state, rule, instanceId, playerId, ignored = []) {
  if (ignored.includes(playerId)) return [];
  return Object.values(runtime(state).monsters).filter(monster => String(monster.instanceId) === String(instanceId)
    && sameName(monster.dungeonName, rule.dungeonName) && sameName(monster.name, rule.monsterName)
    && monster.players?.[playerId] && BigInt(monster.players[playerId].damage) > BigInt(rule.threshold));
}
function evaluate(state, settings, observedAt, enqueue = true) {
  const data = runtime(state), events = [], known = knownAlertKeys(state);
  for (const rule of settings.rules().filter(rule => rule.enabled)) {
    for (const instance of Object.values(state.instances).filter(instance => instance.active && sameName(instance.name, rule.dungeonName))) {
      const monsters = Object.values(data.monsters).filter(monster => String(monster.instanceId) === String(instance.instanceId) && sameName(monster.name, rule.monsterName));
      const players = new Set(monsters.flatMap(monster => Object.keys(monster.players || {})));
      for (const playerId of players) {
        if (settings.data.ignoredPlayerIds.includes(playerId)) continue;
        const qualifying = evidence(state, rule, instance.instanceId, playerId);
        const normalKey = 'damage-count:' + rule.id + ':' + instance.instanceId + ':' + playerId;
        const upperMonsters = rule.upper === null ? [] : monsters.filter(monster => monster.players[playerId]
          && BigInt(monster.players[playerId].damage) >= BigInt(rule.upper)
          && !known.has('damage-upper:' + rule.id + ':' + instance.instanceId + ':' + playerId + ':' + monster.monsterId));
        const countTriggered = qualifying.length >= rule.occurrences && !known.has(normalKey);
        if (!countTriggered && !upperMonsters.length) continue;
        const keys = upperMonsters.map(monster => 'damage-upper:' + rule.id + ':' + instance.instanceId + ':' + playerId + ':' + monster.monsterId);
        if (countTriggered) keys.push(normalKey);
        const seen = new Map([...qualifying, ...upperMonsters].map(monster => [monster.monsterId, monster]));
        const primary = upperMonsters[0] || qualifying[0];
        const player = primary.players[playerId];
        const event = { id: keys[0], dedupKeys: keys, type: 'damage_watch', ruleId: rule.id, ruleName: rule.name, ruleRevision: rule.revision,
          instanceId: instance.instanceId, name: instance.name, playerId, playerName: player.name,
          count: qualifying.length, occurrences: rule.occurrences, threshold: rule.threshold, upper: rule.upper,
          countTriggered, upperTriggered: upperMonsters.length > 0, monsterName: rule.monsterName,
          evidence: [...seen.values()].slice(0, 100).map(monster => ({ monsterId: monster.monsterId, damage: monster.players[playerId].damage, url: monster.url })),
          channelId: rule.channelId, roleId: rule.roleId, url: primary.url, observedAt, status: 'queued' };
        events.push(event);
        if (enqueue) {
          for (const key of keys) data.alerted[key] = observedAt;
          for (const key of keys) known.add(key);
          state.outbox[event.id] = event;
        }
      }
    }
  }
  return events;
}
function applyLeaderboard(state, observation, observedAt) {
  const data = runtime(state);
  const key = battleKey(observation.instanceId, observation.monsterId);
  const previous = data.monsters[key];
  if (!previous) throw new Error('Leaderboard monster was not discovered in a dungeon location');
  const players = { ...(previous.players || {}) };
  for (const player of observation.players) {
    const old = players[player.playerId];
    players[player.playerId] = { name: player.name, damage: old && BigInt(old.damage) > BigInt(player.damage) ? old.damage : player.damage };
    data.players[player.playerId] = { name: player.name, lastObservedAt: observedAt };
  }
  Object.assign(previous, { players, lastObservedAt: observedAt, finalRead: observation.dead, dead: observation.dead });
}
class DamageWatcher {
  constructor(scanner, store, settings, config, now = () => Date.now()) {
    Object.assign(this, { scanner, store, settings, config, now });
    this.locationCursor = 0; this.battleCursor = 0; this.previewRequests = new Map(); this.discoveryRequests = new Map();
  }
  requestPreview(id) { this.settings.get(id); this.previewRequests.set(id, this.now()); }
  requestDiscovery(instanceId) {
    if (!this.store.state.instances[instanceId]?.active) throw new Error('This dungeon is no longer active. Refresh discovery.');
    this.discoveryRequests.set(instanceId, this.now() + Math.max(60000, this.config.pollSeconds * 6000));
  }
  async get(snapshot, url, signal) {
    const key = safeGameUrl(url).toString();
    if (snapshot.pages?.has(key)) return snapshot.pages.get(key);
    const gap = (this.config.watcherReadGapMilliseconds || 0) - (Date.now() - (this.lastReadAt || 0));
    if (gap > 0) await sleep(gap, undefined, { signal });
    this.lastReadAt = Date.now();
    return this.scanner.reader.get(url, signal);
  }
  async scan(snapshot, signal) {
    const state = this.store.state, data = runtime(state);
    const owner = snapshot.owner;
    const errors = [];
    let budget = this.config.watcherReadBudget || 6;
    const rules = this.settings.rules();
    const active = snapshot.instances.filter(instance => instance.active).map(instance => ({ ...instance, instanceId: String(instance.instanceId),
      locations: (instance.locations || []).map(location => ({ ...location, instanceId: String(location.instanceId ?? instance.instanceId) })) }));
    for (const [id, expires] of this.discoveryRequests) if (expires <= this.now() || !active.some(instance => instance.instanceId === id)) this.discoveryRequests.delete(id);
    const configured = active.filter(instance => this.discoveryRequests.has(instance.instanceId) || rules.some(rule => sameName(rule.dungeonName, instance.name)));
    for (const instance of configured) if (!instance.locations?.length) errors.push(instance.name + ': no accessible dungeon locations were discovered');
    // Paused rules discover monster choices, but never schedule leaderboard reads or alerts.
    const locations = configured.flatMap(instance => (instance.locations || []).map(location => ({ ...location, dungeonName: instance.name })));
    const locationLimit = Math.min(locations.length, Math.max(1, Math.floor(budget / 3)));
    for (let index = 0; index < locationLimit; index++) {
      const location = locations[this.locationCursor++ % locations.length];
      signal?.throwIfAborted(); budget--;
      try {
        const page = await this.get(snapshot, location.url, signal);
        const parsed = parseDungeonLocationPage(page.body, { dungeonName: location.dungeonName, instanceId: location.instanceId,
          locationId: location.locationId, locationName: location.name });
        if (parsed.locked) continue;
        const title = stripTags(page.body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
        if (!parsed.recognized || !sameName(parsed.dungeonName, location.dungeonName)
          || !title.toLowerCase().includes(location.dungeonName.toLowerCase()) || !/Monsters in this location/i.test(page.body)
          || parsed.monsters.some(monster => monster.instanceId !== location.instanceId || !monster.name)) throw new Error('Dungeon monster list was not recognized');
        for (const monster of parsed.monsters) {
          const key = battleKey(monster.instanceId, monster.dgmid);
          const previous = data.monsters[key];
          data.monsters[key] = { ...previous, instanceId: monster.instanceId, monsterId: monster.dgmid,
            dungeonName: location.dungeonName, name: monster.name, dead: monster.dead,
            url: '/battle.php?instance_id=' + monster.instanceId + '&dgmid=' + monster.dgmid, players: previous?.players || {} };
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        errors.push(location.dungeonName + ' / ' + location.name + ': ' + error.message);
      }
    }
    const candidates = Object.values(data.monsters).filter(monster => active.some(instance => instance.instanceId === monster.instanceId)
      && rules.some(rule => (rule.enabled || (this.previewRequests.has(rule.id) && Number(monster.lastObservedAt || 0) < this.previewRequests.get(rule.id)))
        && sameName(rule.dungeonName, monster.dungeonName) && sameName(rule.monsterName, monster.name))
      && (!monster.finalRead || !monster.lastObservedAt) && Number(monster.nextReadAt || 0) <= this.now());
    for (let index = 0; index < Math.min(budget, candidates.length); index++) {
      const monster = candidates[this.battleCursor++ % candidates.length];
      signal?.throwIfAborted();
      try {
        const page = await this.get(snapshot, monster.url, signal);
        const observation = inspectLeaderboard(page.body, { instanceId: monster.instanceId, monsterId: monster.monsterId, name: monster.name });
        if (this.scanner.session.owner() !== owner) throw new Error('The game account changed during the watcher scan');
        applyLeaderboard(state, observation, this.now()); delete monster.nextReadAt;
      } catch (error) {
        if (signal?.aborted) throw error;
        monster.nextReadAt = this.now() + Math.max(60000, this.config.pollSeconds * 1000);
        errors.push(monster.name + ' #' + monster.monsterId + ': ' + error.message);
      }
    }
    if (this.scanner.session.owner() !== owner) throw new Error('The game account changed during the watcher scan');
    evaluate(state, this.settings, this.now());
    for (const [id, requestedAt] of this.previewRequests) {
      const rule = this.settings.data.rules[id];
      const pending = rule && Object.values(data.monsters).some(monster => active.some(instance => instance.instanceId === monster.instanceId)
        && sameName(monster.dungeonName, rule.dungeonName) && sameName(monster.name, rule.monsterName)
        && !monster.finalRead && Number(monster.lastObservedAt || 0) < requestedAt);
      if (!pending) this.previewRequests.delete(id);
    }
    const activeIds = new Set(active.map(instance => String(instance.instanceId)));
    // Preserve at most 20 closed dungeon instances; never prune an active instance's counts.
    const closedIds = [...new Set(Object.values(data.monsters).filter(monster => !activeIds.has(String(monster.instanceId))).map(monster => String(monster.instanceId)))]
      .sort((a, b) => (state.instances[b]?.lastObservedAt || 0) - (state.instances[a]?.lastObservedAt || 0));
    const retainedIds = new Set([...activeIds, ...closedIds.slice(0, 20)]);
    for (const [key, monster] of Object.entries(data.monsters)) if (!retainedIds.has(String(monster.instanceId))) delete data.monsters[key];
    for (const key of Object.keys(data.alerted)) if (!retainedIds.has(key.split(':')[2]) || !this.settings.data.rules[key.split(':')[1]]) delete data.alerted[key];
    const retainedPlayers = new Set(Object.values(data.monsters).flatMap(monster => Object.keys(monster.players || {})));
    for (const id of Object.keys(data.players)) if (!retainedPlayers.has(id)) delete data.players[id];
    data.health = { status: errors.length ? 'partial' : 'ok', detail: errors.slice(0, 5).join('; ').slice(0, 1000) };
    data.lastScanAt = this.now(); this.store.save();
  }
  preview(rule) {
    const state = structuredClone(this.store.state);
    return evaluate(state, { data: this.settings.data, rules: () => [{ ...rule, enabled: true }] }, this.now(), false);
  }
}
module.exports = { DamageWatcher, runtime, sameName, evidence, evaluate, applyLeaderboard, battleKey };
