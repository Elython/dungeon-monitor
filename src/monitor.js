const { setTimeout: sleep } = require('node:timers/promises');
const { reduceSnapshot } = require('./model');

class Monitor {
  constructor(scanner, store, publisher, config, log = console.log) {
    Object.assign(this, { scanner, store, publisher, config, log }); this.failures = 0; this.inFlight = null;
  }
  cycle(signal) {
    if (this.inFlight) return this.inFlight;
    const run = this._cycle(signal).finally(() => { if (this.inFlight === run) this.inFlight = null; });
    this.inFlight = run; return run;
  }
  async _cycle(signal) {
    try {
      const snapshot = await this.scanner.scan(signal);
      const events = reduceSnapshot(this.store.state, snapshot, this.config.missingConfirmations);
      this.store.save(); this.failures = 0;
      if (this.watcher) {
        const watcherBefore = structuredClone(this.store.state.watcher || null);
        const outboxBefore = structuredClone(this.store.state.outbox);
        try { await this.watcher.scan(snapshot, signal); }
        catch (error) {
          if (watcherBefore) this.store.state.watcher = watcherBefore; else delete this.store.state.watcher;
          this.store.state.outbox = outboxBefore;
          this.store.state.watcher ||= { monsters: {}, players: {}, alerted: {} };
          this.store.state.watcher.health = { status: 'error', detail: error.message };
          this.store.save();
          if (signal?.aborted) throw error;
          this.log('Damage watcher unavailable: ' + error.message);
        }
      }
      this.log('Scan complete: ' + snapshot.instances.filter(row => row.active).length + ' active dungeon(s), ' + events.length + ' new event(s)');
    } catch (error) {
      if (signal?.aborted) throw error;
      this.failures++;
      this.store.state.health = { status: 'error', detail: error.message, code: error.code || 'READ_FAILED' };
      this.store.save(); this.log('Monitoring unavailable: ' + error.message);
    }
    try { await this.publisher.publish(signal); }
    catch (error) { if (!signal?.aborted) this.log('Notifications unavailable: ' + error.message); }
  }
  async run(signal, once = false) {
    do {
      await this.cycle(signal);
      if (once || signal.aborted) return;
      const seconds = this.config.pollSeconds * Math.min(5, Math.max(1, this.failures));
      await sleep((seconds + Math.random() * 5) * 1000, undefined, { signal });
    } while (!signal.aborted);
  }
}
module.exports = { Monitor };
