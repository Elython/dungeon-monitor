const { emptyState } = require('./storage');

function eventId(type, instanceId, roomId = '') { return type + ':' + instanceId + (roomId ? ':' + roomId : ''); }
function reduceSnapshot(state, snapshot, missingConfirmations = 2) {
  if (state.owner && state.owner !== snapshot.owner) {
    const dashboard = state.dashboard; Object.assign(state, emptyState()); state.dashboard = dashboard;
  }
  state.owner = snapshot.owner;
  const baseline = !state.initialized;
  const seen = new Set();
  const events = [];
  const enqueue = (type, instance, room = null, detail = '') => {
    if (baseline) return;
    const id = eventId(type, instance.instanceId, room?.id);
    if (state.outbox[id]) return;
    const event = { id, type, instanceId: instance.instanceId, name: instance.name,
      url: room?.url || instance.url, roomName: room?.name || null, detail,
      observedAt: snapshot.observedAt, status: 'queued' };
    state.outbox[id] = event; events.push(event);
  };
  for (const observation of snapshot.instances) {
    const id = observation.instanceId; seen.add(id);
    const previous = state.instances[id];
    const instance = { ...previous, ...observation, missingScans: 0, lastObservedAt: snapshot.observedAt, rooms: { ...(previous?.rooms || {}) } };
    if (observation.active && !previous?.active) enqueue('opened', instance);
    if (!observation.active && previous?.active) enqueue('closed', instance, null, observation.status);
    if (observation.active) {
      if (observation.rooms === null || observation.rooms?.length === 0) for (const room of Object.values(instance.rooms)) room.status = 'unknown';
      else for (const room of observation.rooms || []) {
        const normalizeName = value => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
        const aliases = Object.values(instance.rooms).filter(previous => previous.id !== room.id
          && (previous.id.startsWith('locked-boss:') || room.id.startsWith('locked-boss:'))
          && normalizeName(previous.name) === normalizeName(room.name));
        const alias = aliases.length === 1 ? aliases[0] : null;
        const old = instance.rooms[room.id] || alias;
        if (alias) delete instance.rooms[alias.id];
        const current = { ...old, ...room, confirmed: room.status === 'unknown' ? old?.confirmed : room.status };
        instance.rooms[room.id] = current;
        if (room.status === 'open' && old?.confirmed !== 'open' && old?.confirmed !== 'cleared') enqueue('boss_opened', instance, room);
      }
    }
    state.instances[id] = instance;
  }
  for (const instance of Object.values(state.instances)) {
    if (!instance.active || seen.has(instance.instanceId)) continue;
    instance.missingScans = (instance.missingScans || 0) + 1;
    if (instance.missingScans >= missingConfirmations) {
      instance.active = false; instance.status = 'closed'; instance.lastObservedAt = snapshot.observedAt;
      enqueue('closed', instance, null, 'No longer listed after repeated successful directory reads');
    }
  }
  // Retain unresolved sends; bound old closed-instance and delivered-event history.
  const closed = Object.values(state.instances).filter(row => !row.active).sort((a, b) => b.lastObservedAt - a.lastObservedAt);
  for (const instance of closed.slice(500)) delete state.instances[instance.instanceId];
  const delivered = Object.values(state.outbox).filter(row => ['delivered', 'failed', 'preview', 'cancelled'].includes(row.status)).sort((a, b) => b.observedAt - a.observedAt);
  for (const event of delivered.slice(1000)) delete state.outbox[event.id];
  state.initialized = true; state.lastScanAt = snapshot.observedAt;
  state.health = { status: snapshot.warnings.length ? 'partial' : 'ok', detail: snapshot.warnings.join('; ').slice(0, 500) };
  return events;
}
module.exports = { reduceSnapshot, eventId };
