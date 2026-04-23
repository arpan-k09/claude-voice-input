// SPDX-License-Identifier: MIT
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function clearModuleCache() {
  [
    require.resolve('../src/transcriber'),
    require.resolve('../src/platform'),
  ].forEach(k => { delete require.cache[k]; });
}

// Stub os.homedir, reload modules, run fn, restore.
async function withHome(fakeHome, fn) {
  const origHomedir = os.homedir;
  os.homedir = () => fakeHome;
  clearModuleCache();
  try {
    await fn(require('../src/transcriber'));
  } finally {
    os.homedir = origHomedir;
    clearModuleCache();
  }
}

// Stub cp.execFile, reload modules, run fn, restore.
async function withExecFile(stub, fn) {
  const orig = cp.execFile;
  cp.execFile = stub;
  clearModuleCache();
  try {
    await fn(require('../src/transcriber'));
  } finally {
    cp.execFile = orig;
    clearModuleCache();
  }
}

// --- Windows combined .txt pass-through ---

test('transcribe returns content of .txt file directly (Windows combined path)', async () => {
  const tmp = path.join(os.tmpdir(), `cvi-test-${Date.now()}.txt`);
  fs.writeFileSync(tmp, 'hello world');
  try {
    clearModuleCache();
    const transcriber = require('../src/transcriber');
    const result = await transcriber.transcribe(tmp);
    assert.strictEqual(result, 'hello world');
  } finally {
    fs.unlinkSync(tmp);
    clearModuleCache();
  }
});

test('transcribe returns empty string for empty .txt file', async () => {
  const tmp = path.join(os.tmpdir(), `cvi-test-${Date.now()}.txt`);
  fs.writeFileSync(tmp, '');
  try {
    clearModuleCache();
    const transcriber = require('../src/transcriber');
    const result = await transcriber.transcribe(tmp);
    assert.strictEqual(result, '');
  } finally {
    fs.unlinkSync(tmp);
    clearModuleCache();
  }
});

// --- _run helper ---

test('_run resolves with trimmed stdout on exit 0', async () => {
  await withExecFile((_bin, _args, _opts, cb) => {
    setTimeout(() => cb(null, '  hello world\n', ''), 5);
    return { stderr: { on: () => {} } };
  }, async (transcriber) => {
    const result = await transcriber._run('fake', []);
    assert.strictEqual(result, 'hello world');
  });
});

test('_run rejects with error message on non-zero exit', async () => {
  await withExecFile((_bin, _args, _opts, cb) => {
    const err = new Error('Command failed');
    err.killed = false;
    setTimeout(() => cb(err, '', 'some stderr'), 5);
    return { stderr: { on: () => {} } };
  }, async (transcriber) => {
    let threw = false;
    try { await transcriber._run('fake', []); } catch { threw = true; }
    assert.ok(threw, 'expected _run to reject on non-zero exit');
  });
});

test('_run rejects with "timed out" message when process is killed', async () => {
  await withExecFile((_bin, _args, _opts, cb) => {
    const err = new Error('ETIMEDOUT');
    err.killed = true;
    setTimeout(() => cb(err, '', ''), 5);
    return { stderr: { on: () => {} } };
  }, async (transcriber) => {
    let msg = '';
    try { await transcriber._run('fake', []); } catch (e) { msg = e.message; }
    assert.ok(msg.includes('timed out'), `Expected "timed out" in: ${msg}`);
  });
});

// --- whisper opt-in ---

test('transcribe uses whisper binary when config.whisper=true and binary+model present', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cvi-w-'));
  const wDir = path.join(home, '.claude', 'claude-voice-input', 'whisper');
  const modelDir = path.join(wDir, 'models');
  fs.mkdirSync(modelDir, { recursive: true });
  const binPath = path.join(wDir, 'main');
  fs.writeFileSync(binPath, '#!/bin/sh\necho "hello whisper"', { mode: 0o755 });
  fs.writeFileSync(path.join(modelDir, 'ggml-tiny.en.bin'), 'fake');

  const cfgDir = path.join(home, '.claude', 'claude-voice-input');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({ whisper: true }));

  let calledBin = '';
  const origExecFile = cp.execFile;
  cp.execFile = (bin, args, opts, cb) => {
    calledBin = bin;
    setTimeout(() => cb(null, 'hello whisper\n', ''), 5);
    return { stderr: { on: () => {} } };
  };

  await withHome(home, async (transcriber) => {
    const result = await transcriber.transcribe('/tmp/fake.wav');
    assert.ok(calledBin.includes('main'), `Expected whisper binary, got: ${calledBin}`);
    assert.strictEqual(result, 'hello whisper');
  });

  cp.execFile = origExecFile;
});

test('transcribe throws with setup --whisper hint when whisper flagged but binary missing', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cvi-nm-'));
  const cfgDir = path.join(home, '.claude', 'claude-voice-input');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({ whisper: true }));

  await withHome(home, async (transcriber) => {
    let msg = '';
    try { await transcriber.transcribe('/tmp/fake.wav'); } catch (e) { msg = e.message; }
    assert.ok(msg.includes('setup --whisper'), `Expected setup hint, got: ${msg}`);
  });
});

// --- _readConfig ---

test('_readConfig returns {} when no config file exists', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cvi-cfg-'));
  await withHome(home, async (transcriber) => {
    const cfg = transcriber._readConfig();
    assert.deepStrictEqual(cfg, {});
  });
});

test('_readConfig returns {} on malformed JSON', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cvi-bad-'));
  const cfgDir = path.join(home, '.claude', 'claude-voice-input');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'config.json'), '{ not json }');
  await withHome(home, async (transcriber) => {
    const cfg = transcriber._readConfig();
    assert.deepStrictEqual(cfg, {});
  });
});

(async () => {
  let passed = 0, failed = 0;
  console.log('transcriber');
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ok   ${name}`);
      passed++;
    } catch (e) {
      console.log(`  FAIL ${name}\n       ${e.message}`);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
