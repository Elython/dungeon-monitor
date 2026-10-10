// Pure verified parser snapshot from Veybot, 2026-10-09. No runtime dependency on Veybot.

function decodeHtml(value = '') {
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function stripTags(value = '') {
  return decodeHtml(String(value).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function parseNumber(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).replace(/,/g, '').trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function parseAttributes(source = '') {
  const attributes = {};
  const regex = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match;
  while ((match = regex.exec(source)) !== null) {
    const name = match[1].toLowerCase();
    if (name === '<' || name.startsWith('<')) continue;
    attributes[name] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attributes;
}

function hasClass(attributes, className) {
  return String(attributes.class || '').split(/\s+/).includes(className);
}

function elementBlocks(html, tagName, className) {
  const blocks = [];
  const openRegex = new RegExp(`<${tagName}\\b([^>]*)>`, 'gi');
  const openings = [];
  let match;
  while ((match = openRegex.exec(html)) !== null) {
    const attributes = parseAttributes(match[1]);
    if (hasClass(attributes, className)) {
      openings.push({ index: match.index, end: openRegex.lastIndex, attributes });
    }
  }

  for (let index = 0; index < openings.length; index++) {
    const current = openings[index];
    const nextStart = openings[index + 1]?.index ?? html.length;
    blocks.push({
      attributes: current.attributes,
      html: html.slice(current.end, nextStart),
      start: current.index,
    });
  }
  return blocks;
}

function findClassValue(html, className) {
  const regex = new RegExp(`<[^>]+class=(?:"[^"]*\\b${className}\\b[^"]*"|'[^']*\\b${className}\\b[^']*')[^>]*>([\\s\\S]*?)<\\/[^>]+>`, 'i');
  const match = html.match(regex);
  return match ? stripTags(match[1]) : null;
}

function parseGuildDungeonIndex(html) {
  const source = String(html || '');
  const activeMarker = source.search(/Active Dungeon Templates/i);
  const clearMarker = source.search(/Previous Instances\s*\(Clears\)/i);
  const failedMarker = source.search(/Previous Instances\s*\(Failed\)/i);
  if (activeMarker < 0) return { recognized: false, instances: [] };
  const endMarker = source.indexOf('async function openDungeon', activeMarker);
  const catalog = source.slice(activeMarker, endMarker > activeMarker ? endMarker : source.length);
  const relativeClearMarker = clearMarker >= activeMarker ? clearMarker - activeMarker : Number.POSITIVE_INFINITY;
  const relativeFailedMarker = failedMarker >= activeMarker ? failedMarker - activeMarker : Number.POSITIVE_INFINITY;
  const instances = [];

  for (const card of elementBlocks(catalog, 'div', 'card')) {
    const name = findClassValue(card.html, 'h');
    const link = card.html.match(/href=["']([^"']*guild_dungeon_enter\.php\?[^"']*\bid=\d+[^"']*)["']/i);
    if (!name || !link) continue;
    let url;
    try {
      url = new URL(decodeHtml(link[1]), 'https://demonicscans.org/guild_dungeon.php');
    } catch {
      continue;
    }
    const instanceId = url.searchParams.get('id');
    if (!/^\d+$/.test(instanceId || '') || instances.some(entry => entry.instanceId === instanceId)) continue;
    const text = stripTags(card.html);
    const inActiveSection = card.start < relativeClearMarker;
    const inFailedSection = card.start >= relativeFailedMarker;
    const status = inActiveSection
      ? 'active'
      : (text.match(/Status:\s*(ended|failed)/i)?.[1] || (inFailedSection ? 'failed' : 'ended')).toLowerCase();
    const guildLootState = /\bNo loot\b/i.test(text)
      ? 'none'
      : /\bNot looted\b/i.test(text)
        ? 'pending'
        : /\bLooted\b/i.test(text)
          ? 'claimed'
          : 'unknown';
    instances.push({
      name,
      instanceId,
      status,
      active: status === 'active',
      guildLootState,
      url: `${url.pathname}${url.search}`,
    });
  }

  return {
    recognized: /Guild Dungeons/i.test(source) && activeMarker >= 0,
    instances,
  };
}

function parseDungeonInstancePage(html) {
  const source = String(html || '');
  const title = stripTags(source.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
  const titleMatch = title.match(/^(.+?)\s*(?:—|-)\s*Instance\s*#(\d+)\s*$/i);
  const locationRegex = /<a\b([^>]*)href=["']([^"']*guild_dungeon_location\.php\?[^"']+)["']([^>]*)>/gi;
  const locations = [];
  let match;
  while ((match = locationRegex.exec(source)) !== null) {
    let url;
    try {
      url = new URL(decodeHtml(match[2]), 'https://demonicscans.org/');
    } catch {
      continue;
    }
    const instanceId = url.searchParams.get('instance_id');
    const locationId = url.searchParams.get('location_id');
    if (!/^\d+$/.test(instanceId || '') || !/^\d+$/.test(locationId || '')) continue;
    if (locations.some(location => location.locationId === locationId)) continue;
    const attributes = parseAttributes(`${match[1]} ${match[3]}`);
    const name = String(attributes.title || `Location ${locationId}`).replace(/\s*\(Boss\)\s*$/i, '').trim();
    locations.push({
      instanceId,
      locationId,
      name,
      boss: /boss/i.test(attributes.title || ''),
      url: `${url.pathname}${url.search}`,
    });
  }
  return {
    recognized: Boolean(titleMatch && locations.length > 0),
    dungeonName: titleMatch?.[1]?.trim() || null,
    instanceId: titleMatch?.[2] || locations[0]?.instanceId || null,
    active: /Status:\s*<b>\s*Active\s*<\/b>/i.test(source),
    locations,
  };
}

function parseDungeonLocationPage(html, context = {}) {
  const source = String(html || '');
  const title = stripTags(source.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
  const titleParts = title.split(/\s*(?:—|-)\s*/);
  const dungeonName = String(context.dungeonName || titleParts[0] || '').trim();
  const locationName = String(context.locationName || titleParts.slice(1).join(' — ') || '').trim();
  const playerBlock = elementBlocks(source, 'div', 'playerhp')[0]?.html || '';
  const playerHpMatch = stripTags(playerBlock).match(/([\d,]+)\s*\/\s*([\d,]+)/);
  const locationLocked = /Boss is locked until other locations are cleared|<span\b[^>]*class=["'][^"']*\bpill\b[^"']*["'][^>]*>\s*locked\s*<\/span>/i.test(source);
  const monsters = [];

  for (const block of elementBlocks(source, 'div', 'mon')) {
    const hrefMatch = block.html.match(/href=["']([^"']*battle\.php\?[^"']*\bdgmid=\d+[^"']*)["']/i);
    if (!hrefMatch) continue;
    let url;
    try {
      url = new URL(decodeHtml(hrefMatch[1]), 'https://demonicscans.org/');
    } catch {
      continue;
    }
    const dgmid = url.searchParams.get('dgmid');
    const instanceId = url.searchParams.get('instance_id') || String(context.instanceId || '');
    if (!/^\d+$/.test(dgmid || '') || !/^\d+$/.test(instanceId || '')) continue;

    const headingStart = block.html.search(/<div\b[^>]*font-weight\s*:\s*700/i);
    const headingMarkers = headingStart >= 0
      ? [
        block.html.indexOf('<div class="bar"', headingStart),
        block.html.slice(headingStart).search(/<div\b[^>]*class=["'][^"']*\bmuted\b/i) + headingStart,
      ].filter(index => index > headingStart)
      : [];
    const headingEnd = headingMarkers.length > 0 ? Math.min(...headingMarkers) : -1;
    const heading = headingStart >= 0
      ? block.html.slice(headingStart, headingEnd >= 0 ? headingEnd : Math.min(block.html.length, headingStart + 1200))
      : '';
    const headingInner = heading
      .replace(/^<div\b[^>]*>/i, '')
      .replace(/<\/div>\s*$/i, '');
    const directName = headingInner.slice(headingInner.lastIndexOf('</div>') + 6);
    const name = stripTags(directName).replace(/\s+dead\s*$/i, '').trim();
    const hpMatch = block.html.match(/([\d,]+)\s*\/\s*([\d,]+)\s*HP/i);
    const statValue = label => {
      const expression = new RegExp(`<span\\b[^>]*class=["'][^"']*\\bk\\b[^"']*["'][^>]*>\\s*${label}\\s*<\\/span>[\\s\\S]*?<span\\b[^>]*class=["'][^"']*\\bv\\b[^"']*["'][^>]*>([^<]+)<\\/span>`, 'i');
      return parseNumber(stripTags(block.html.match(expression)?.[1] || ''));
    };
    const hp = parseNumber(hpMatch?.[1]);
    const maxHp = parseNumber(hpMatch?.[2]);
    const dead = hasClass(block.attributes, 'dead') || hp === 0;
    const joined = /<span\b[^>]*class=["'][^"']*\bpill\b[^"']*["'][^>]*>\s*joined\s*<\/span>/i.test(block.html);
    const lootable = dead && /<span\b[^>]*class=["'][^"']*\bpill-warn\b[^"']*["'][^>]*>\s*not looted\s*<\/span>/i.test(block.html);
    monsters.push({
      id: dgmid,
      battleId: dgmid,
      dgmid,
      instanceId,
      name,
      dungeonName,
      locationId: String(context.locationId || ''),
      locationName,
      boss: context.boss === true,
      hp,
      maxHp,
      attack: statValue('ATK'),
      defense: statValue('DEF'),
      expPerDamage: statValue('EXP\\s*\/\\s*dmg'),
      joined,
      dead,
      lootable,
      attackable: !dead && !locationLocked,
      battleRef: { isDungeon: true, instanceId, dgmid },
    });
  }

  return {
    recognized: Boolean(dungeonName && locationName),
    dungeonName,
    instanceId: String(context.instanceId || monsters[0]?.instanceId || ''),
    locationId: String(context.locationId || ''),
    locationName,
    boss: context.boss === true,
    locked: locationLocked,
    resources: playerHpMatch ? { hp: { current: parseNumber(playerHpMatch[1]), max: parseNumber(playerHpMatch[2]) } } : {},
    monsters,
  };
}

function extractBalancedObject(source, assignmentPattern) {
  const assignment = assignmentPattern.exec(source);
  if (!assignment) return null;
  const start = source.indexOf('{', assignment.index + assignment[0].length);
  if (start < 0) return null;
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  return null;
}

class LiteralParser {
  constructor(source) {
    this.source = source;
    this.index = 0;
  }

  parse() {
    const value = this.value();
    this.space();
    if (this.index !== this.source.length) throw new Error('Unexpected content after object literal');
    return value;
  }

  space() {
    while (/\s/.test(this.source[this.index] || '')) this.index++;
  }

  value() {
    this.space();
    const char = this.source[this.index];
    if (char === '{') return this.object();
    if (char === '[') return this.array();
    if (char === '"' || char === "'") return this.string();
    if (char === '-' || /\d/.test(char || '')) return this.number();
    const identifier = this.identifier();
    if (identifier === 'true') return true;
    if (identifier === 'false') return false;
    if (identifier === 'null') return null;
    throw new Error(`Unsupported literal value: ${identifier || char}`);
  }

  object() {
    const result = {};
    this.index++;
    while (true) {
      this.space();
      if (this.source[this.index] === '}') { this.index++; return result; }
      const key = ['"', "'"].includes(this.source[this.index]) ? this.string() : this.identifier();
      if (!key) throw new Error('Object key expected');
      this.space();
      if (this.source[this.index++] !== ':') throw new Error(`Missing colon after ${key}`);
      result[key] = this.value();
      this.space();
      if (this.source[this.index] === ',') { this.index++; continue; }
      if (this.source[this.index] === '}') { this.index++; return result; }
      throw new Error('Expected comma or closing brace');
    }
  }

  array() {
    const result = [];
    this.index++;
    while (true) {
      this.space();
      if (this.source[this.index] === ']') { this.index++; return result; }
      result.push(this.value());
      this.space();
      if (this.source[this.index] === ',') { this.index++; continue; }
      if (this.source[this.index] === ']') { this.index++; return result; }
      throw new Error('Expected comma or closing bracket');
    }
  }

  string() {
    const quote = this.source[this.index++];
    let result = '';
    while (this.index < this.source.length) {
      const char = this.source[this.index++];
      if (char === quote) return result;
      if (char === '\\') {
        const escaped = this.source[this.index++];
        const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
        result += escapes[escaped] ?? escaped;
      } else {
        result += char;
      }
    }
    throw new Error('Unterminated string literal');
  }

  number() {
    const match = this.source.slice(this.index).match(/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/i);
    if (!match) throw new Error('Invalid numeric literal');
    this.index += match[0].length;
    return Number(match[0]);
  }

  identifier() {
    this.space();
    const match = this.source.slice(this.index).match(/^[A-Za-z_$][\w$]*/);
    if (!match) return '';
    this.index += match[0].length;
    return match[0];
  }
}

function parseObjectLiteral(source) {
  return new LiteralParser(source).parse();
}

function parseCubeHomePage(html) {
  const objectSource = extractBalancedObject(String(html || ''), /(?:const|let|var)\s+STATE\s*=/);
  if (!objectSource) return { recognized: false, instanceId: null, faces: [], nodes: [] };
  let state;
  try {
    state = parseObjectLiteral(objectSource);
  } catch {
    return { recognized: false, instanceId: null, faces: [], nodes: [] };
  }
  const instanceMatch = String(html || '').match(/[?&]instance_id=(\d+)/i)
    || String(html || '').match(/\bINSTANCE_ID\s*=\s*(\d+)/i);
  const allowedStatuses = new Set(['hidden', 'available', 'in_progress', 'cleared']);
  const faces = (Array.isArray(state.faces) ? state.faces : []).map(face => ({
    id: Number(face.ID ?? face.id) || null,
    key: String(face.FACE_KEY ?? face.face_key ?? ''),
    name: String(face.DISPLAY_NAME ?? face.display_name ?? ''),
    order: Number(face.DISPLAY_ORDER ?? face.display_order) || 0,
  }));
  const nodes = (Array.isArray(state.nodes) ? state.nodes : []).map(node => ({
    id: Number(node.id) || null,
    faceKey: String(node.face_key || ''),
    key: String(node.key || ''),
    name: String(node.name || ''),
    type: String(node.type || '').toLowerCase(),
    status: allowedStatuses.has(String(node.status || '').toLowerCase()) ? String(node.status).toLowerCase() : 'hidden',
    linkedLocationId: Number(node.linked_location_id) || null,
    pvpEncounterId: Number(node.pvp_encounter_id) || null,
    monstersTotal: Number(node.monsters_total) || 0,
    monstersLeft: Number(node.monsters_left) || 0,
    stateMeta: node.state_meta && typeof node.state_meta === 'object' && !Array.isArray(node.state_meta) ? node.state_meta : {},
  })).filter(node => node.id && node.name);
  return {
    recognized: Array.isArray(state.nodes),
    instanceId: instanceMatch ? Number(instanceMatch[1]) : null,
    selectedNodeId: Number(state.selected_node_id) || null,
    currentFaceKey: String(state.current_face_key || ''),
    faces,
    nodes,
  };
}

module.exports = { parseGuildDungeonIndex, parseDungeonInstancePage, parseDungeonLocationPage, parseCubeHomePage, stripTags, parseAttributes, hasClass };
