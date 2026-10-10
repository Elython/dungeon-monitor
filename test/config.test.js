const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../src/config');

test('polling supports 30 seconds while preserving defaults and request spacing', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-config-test-'));
  try {
    const file = path.join(directory, 'config.json');
    fs.writeFileSync(file, '{}');
    const defaults = loadConfig(file);
    assert.equal(defaults.pollSeconds, 120);
    for (const value of [30, 60, 120, 3600]) {
      fs.writeFileSync(file, JSON.stringify({ pollSeconds: value }));
      const config = loadConfig(file);
      assert.equal(config.pollSeconds, value);
      assert.equal(config.requestGapMilliseconds, defaults.requestGapMilliseconds);
      assert.equal(config.watcherReadGapMilliseconds, defaults.watcherReadGapMilliseconds);
      assert.equal(config.requestTimeoutSeconds, defaults.requestTimeoutSeconds);
      assert.equal(config.watcherReadBudget, defaults.watcherReadBudget);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('polling rejects values below 30 seconds or above one hour', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-config-bounds-test-'));
  try {
    const file = path.join(directory, 'config.json');
    for (const value of [-1, 0, 29, 29.99, 3601, 'invalid']) {
      fs.writeFileSync(file, JSON.stringify({ pollSeconds: value }));
      assert.throws(() => loadConfig(file), /outside its allowed range/);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
