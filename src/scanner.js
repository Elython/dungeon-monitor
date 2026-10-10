const { parseGuildDungeonIndex, parseDungeonInstancePage, parseDungeonLocationPage, parseCubeHomePage, stripTags, parseAttributes, hasClass } = require('../vendor/dungeonParsers');
const { problem, safeGameUrl } = require('./transport');

function inspectDirectory(html) {
  const parsed = parseGuildDungeonIndex(html);
  const references = new Set([...html.matchAll(/guild_dungeon_enter\.php\?[^"'<>]*?\bid=(\d+)/gi)].map(match => match[1]));
  if (!parsed.recognized || references.size !== parsed.instances.length) throw problem('Dungeon directory format was not fully recognized; previous state was retained', 'PARSE_FAILED');
  for (const instance of parsed.instances) {
    const url = safeGameUrl(instance.url);
    if (url.searchParams.get('id') !== instance.instanceId) throw problem('Dungeon instance link did not match its ID', 'PARSE_FAILED');
  }
  return parsed.instances.map(instance => ({ ...instance, status: instance.status === 'ended' ? 'cleared' : instance.status }));
}
function inspectRoom(html, context) {
  const parsed = parseDungeonLocationPage(html, context);
  if (parsed.locked) return { status: 'locked' };
  const title = stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').toLowerCase();
  if (!title.includes(context.dungeonName.toLowerCase()) || !title.includes(context.locationName.toLowerCase())
    || !/Monsters in this location/i.test(html) || parsed.monsters.length === 0
    || parsed.monsters.some(monster => monster.instanceId !== context.instanceId)) return { status: 'unknown', detail: 'Boss room response did not prove access' };
  return { status: parsed.monsters.some(monster => monster.attackable) ? 'open' : 'cleared' };
}
function inspectLockedBossPins(html, mapUrl) {
  const rooms = [];
  for (const anchor of html.matchAll(/<a\b([^>]*)>/gi)) {
    const attributes = parseAttributes(anchor[1]);
    if (!hasClass(attributes, 'pin') || !hasClass(attributes, 'locked') || !/\(Boss\)/i.test(attributes.title || '')) continue;
    const name = String(attributes.title).replace(/\s*(?:—|-)\s*locked\s*$/i, '').replace(/\s*\(Boss\)\s*$/i, '').trim();
    if (!name) continue;
    rooms.push({ id: 'locked-boss:' + encodeURIComponent(name.toLowerCase()), name, url: mapUrl, status: 'locked' });
  }
  return rooms;
}

class DungeonScanner {
  constructor(reader, session, now = () => Date.now()) { this.reader = reader; this.session = session; this.now = now; }
  async scan(signal) {
    this.session.reloadIfChanged();
    const dashboard = await this.reader.get('/game_dash.php', signal);
    if (!/<[^>]*class=["'][^"']*\bsmall-name\b[^"']*["'][^>]*>\s*[^<\s]/i.test(dashboard.body)) throw problem('The Dashboard did not confirm a logged-in account', 'AUTH_REQUIRED');
    const owner = this.session.owner();
    const pages = new Map();
    const read = async url => {
      const key = safeGameUrl(url).toString();
      if (!pages.has(key)) pages.set(key, await this.reader.get(url, signal));
      return pages.get(key);
    };
    const directory = await this.reader.get('/guild_dungeon.php', signal);
    const instances = inspectDirectory(directory.body);
    const warnings = [];
    for (const instance of instances.filter(row => row.active)) {
      signal?.throwIfAborted();
      instance.rooms = [];
      try {
        const response = await read(instance.url);
        const cube = parseCubeHomePage(response.body);
        if (cube.recognized) {
          if (cube.instanceId && String(cube.instanceId) !== instance.instanceId) throw problem('Cube response referred to another instance', 'PARSE_FAILED');
          instance.locations = cube.nodes.filter(node => ['pve', 'boss'].includes(node.type) && node.linkedLocationId && node.status !== 'hidden')
            .map(node => ({ instanceId: instance.instanceId, locationId: String(node.linkedLocationId), name: node.name,
              url: '/guild_dungeon_location.php?instance_id=' + instance.instanceId + '&location_id=' + node.linkedLocationId }));
          const bosses = cube.nodes.filter(node => node.type === 'boss' && [11, 12, 13, 14].includes(node.linkedLocationId));
          instance.rooms = bosses.map(node => ({ id: 'cube-node:' + node.id, name: node.name,
            url: response.url, status: node.status === 'hidden' ? 'locked' : node.status === 'cleared' ? 'cleared' : 'open' }));
          if (!bosses.length) warnings.push(instance.name + ': no verified boss node was found');
          continue;
        }
        const parsed = parseDungeonInstancePage(response.body);
        if (!parsed.recognized || parsed.instanceId !== instance.instanceId) throw problem('Dungeon location links were not recognized', 'PARSE_FAILED');
        instance.locations = parsed.locations;
        instance.rooms.push(...inspectLockedBossPins(response.body, response.url));
        for (const location of parsed.locations.filter(row => row.boss)) {
          const url = safeGameUrl(location.url);
          if (location.instanceId !== instance.instanceId || url.searchParams.get('instance_id') !== instance.instanceId) throw problem('Boss room link referred to another instance', 'PARSE_FAILED');
          const room = { id: 'location:' + location.locationId, name: location.name, url: url.toString(), status: 'unknown' };
          try {
            const page = await read(url);
            Object.assign(room, inspectRoom(page.body, { dungeonName: parsed.dungeonName,
              instanceId: instance.instanceId, locationId: location.locationId, locationName: location.name, boss: true }));
          } catch (error) {
            if (signal?.aborted || ['AUTH_REQUIRED', 'CHALLENGE_REQUIRED', 'NOT_IN_GUILD'].includes(error.code)) throw error;
            room.detail = error.message;
          }
          instance.rooms.push(room);
        }
        if (!instance.rooms.length) warnings.push(instance.name + ': boss room identity is not exposed by this page');
      } catch (error) {
        if (signal?.aborted || ['AUTH_REQUIRED', 'CHALLENGE_REQUIRED', 'NOT_IN_GUILD'].includes(error.code)) throw error;
        warnings.push(instance.name + ': ' + error.message);
        instance.rooms = null;
      }
    }
    if (this.session.owner() !== owner) throw problem('The game account changed during this scan', 'AUTH_REQUIRED');
    return { owner, instances, warnings, observedAt: this.now(), pages };
  }
}
module.exports = { DungeonScanner, inspectDirectory, inspectRoom, inspectLockedBossPins };
