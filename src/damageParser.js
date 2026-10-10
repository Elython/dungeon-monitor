const { stripTags, parseAttributes, hasClass } = require('../vendor/dungeonParsers');
const { BASE_URL } = require('./config');
const { problem } = require('./transport');

const idPattern = /^[1-9]\d{0,29}$/;
function integer(value) {
  const text = String(value).trim();
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(text) || text.length > 60) throw problem('Damage value was not recognized', 'PARSE_FAILED');
  return BigInt(text.replaceAll(',', '')).toString();
}
function blocks(source, className) {
  const result = [];
  const opens = /<div\b([^>]*)>/gi;
  let opening;
  while ((opening = opens.exec(source))) {
    if (!hasClass(parseAttributes(opening[1]), className)) continue;
    const tags = /<\/?div\b[^>]*>/gi;
    tags.lastIndex = opens.lastIndex;
    let depth = 1, tag;
    while (depth && (tag = tags.exec(source))) depth += /^<\//.test(tag[0]) ? -1 : 1;
    if (depth) throw problem('Leaderboard markup was incomplete', 'PARSE_FAILED');
    result.push(source.slice(opens.lastIndex, tag.index));
  }
  return result;
}
function inspectLeaderboard(source, expected) {
  const config = String(source).match(/window\.BATTLE_CFG\s*=\s*\{([\s\S]*?)\n\s*\};/)?.[1];
  const instanceId = config?.match(/\binstanceId\s*:\s*(\d+)/)?.[1];
  const monsterId = config?.match(/\bdgmid\s*:\s*(\d+)/)?.[1];
  if (!config || !/\bisDungeon\s*:\s*true\b/.test(config) || instanceId !== String(expected.instanceId) || monsterId !== String(expected.monsterId)) {
    throw problem('Leaderboard response did not match the requested dungeon monster', 'PARSE_FAILED');
  }
  const markup = String(source).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  const panels = blocks(markup, 'leaderboard-panel');
  if (panels.length !== 1 || !/Attackers Leaderboard/i.test(stripTags(panels[0])) || blocks(panels[0], 'lb-list').length !== 1) {
    throw problem('Attackers Leaderboard was not recognized', 'PARSE_FAILED');
  }
  const title = blocks(markup, 'card-title')[0];
  const name = title && stripTags(title.replace(/<span\b[^>]*>[\s\S]*?<\/span>/gi, '')).replace(/^[^\p{L}\p{N}]+/u, '').trim();
  if (!name || (expected.name && name !== expected.name)) throw problem('Leaderboard monster name did not match discovery', 'PARSE_FAILED');
  const players = [];
  const seen = new Set();
  for (const row of blocks(panels[0], 'lb-row')) {
    const link = row.match(/<a\b([^>]*)>([\s\S]*?)<\/a>/i);
    const attributes = parseAttributes(link?.[1] || '');
    let url;
    try { url = new URL(attributes.href, BASE_URL); } catch { /* rejected below */ }
    const playerId = url?.searchParams.get('pid');
    const damage = row.match(/<span\b[^>]*class=["'][^"']*\blb-dmg\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
    const match = stripTags(damage?.[1] || '').match(/^([\d,]+)\s+DMG$/i);
    const playerName = stripTags(link?.[2] || '');
    if (!url || url.origin !== BASE_URL || url.pathname !== '/player.php' || !idPattern.test(playerId || '') || !playerName || !match || seen.has(playerId)) {
      throw problem('A leaderboard row was missing a unique player ID or damage total', 'PARSE_FAILED');
    }
    seen.add(playerId);
    players.push({ playerId, name: playerName.slice(0, 160), damage: integer(match[1]) });
  }
  if (/pagination|next page|top\s+\d+\s+(?:players|attackers)/i.test(stripTags(panels[0])) || /[?&](?:page|offset)=\d/i.test(panels[0])) {
    throw problem('Leaderboard appears paginated or limited; complete capture is needed', 'PARSE_FAILED');
  }
  return { instanceId, monsterId, name, players, dead: /\bDEAD\b/.test(stripTags(title || '')), visibility: 'Only server-visible leaderboard rows are observable' };
}
module.exports = { inspectLeaderboard, integer, idPattern };
