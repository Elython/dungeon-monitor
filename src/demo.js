const { emptyState } = require('./storage');
const { reduceSnapshot } = require('./model');
const { announcement, dashboard } = require('./messages');
const { inspectDirectory } = require('./scanner');
const fs = require('node:fs');
const path = require('node:path');

const state = emptyState();
const instances = inspectDirectory(fs.readFileSync(path.join(__dirname, '../test/fixtures/guild_dungeon_index.html'), 'utf8'));
const initial = instances.map(row => ({ ...row, rooms: row.active ? [{ id: 'location:5', name: 'Boss Room', status: 'locked', url: row.url }] : [] }));
reduceSnapshot(state, { owner: 'demo', instances: initial, warnings: [], observedAt: Date.now() });
console.log('First scan establishes a baseline without old announcements.\n' + dashboard(state).content);
const second = structuredClone(initial); second[0].rooms[0].status = 'open';
for (const event of reduceSnapshot(state, { owner: 'demo', instances: second, warnings: [], observedAt: Date.now() + 120000 })) console.log('\n' + announcement(event).content);
const third = structuredClone(second); third[0].active = false; third[0].status = 'cleared';
for (const event of reduceSnapshot(state, { owner: 'demo', instances: third, warnings: [], observedAt: Date.now() + 240000 })) console.log('\n' + announcement(event).content);
console.log('\nDemo finished. No network request or local account/state write was performed.');
