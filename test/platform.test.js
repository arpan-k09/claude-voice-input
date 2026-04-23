// SPDX-License-Identifier: MIT
'use strict';

const assert = require('assert');

// Re-require platform.js with a fake process.platform value.
function loadPlatformAs(fakePlatform) {
  const key = require.resolve('../src/platform');
  delete require.cache[key];
  const desc = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: fakePlatform, configurable: true });
  const mod = require('../src/platform');
  if (desc) Object.defineProperty(process, 'platform', desc);
  else delete process.platform;
  return mod;
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// --- Escape helpers ---

test('_escapeOsascript: escapes backslash and double-quote', () => {
  const p = loadPlatformAs('darwin');
  assert.strictEqual(p._escapeOsascript('say "hi"'), 'say \\"hi\\"');
  assert.strictEqual(p._escapeOsascript('a\\b'), 'a\\\\b');
});

test('_escapeOsascript: leaves normal text untouched', () => {
  const p = loadPlatformAs('darwin');
  assert.strictEqual(p._escapeOsascript('Hello world'), 'Hello world');
  assert.strictEqual(p._escapeOsascript('use `backtick`'), 'use `backtick`');
});

test('_escapeSendKeys: escapes SendKeys special characters', () => {
  const p = loadPlatformAs('win32');
  assert.strictEqual(p._escapeSendKeys('1+2'), '1{+}2');
  assert.strictEqual(p._escapeSendKeys('a^b'), 'a{^}b');
  assert.strictEqual(p._escapeSendKeys('(test)'), '{(}test{)}');
  assert.strictEqual(p._escapeSendKeys('{x}'), '{{}x{}}');
});

test('_escapeSendKeys: leaves normal text untouched', () => {
  const p = loadPlatformAs('win32');
  assert.strictEqual(p._escapeSendKeys('Hello world'), 'Hello world');
  assert.strictEqual(p._escapeSendKeys('foo123'), 'foo123');
});

// --- injectionCmd ---

test('injectionCmd on darwin returns osascript with keystroke', () => {
  const p = loadPlatformAs('darwin');
  const cmd = p.injectionCmd('hello');
  assert.strictEqual(cmd.bin, 'osascript');
  const joined = cmd.args.join(' ');
  assert.ok(joined.includes('keystroke'), 'should use keystroke');
  assert.ok(joined.includes('hello'), 'should include text');
  assert.ok(joined.includes('System Events'), 'should target System Events');
});

test('injectionCmd on darwin escapes double-quote in text', () => {
  const p = loadPlatformAs('darwin');
  const cmd = p.injectionCmd('say "hello"');
  const joined = cmd.args.join(' ');
  assert.ok(joined.includes('\\"hello\\"'), 'double-quotes should be escaped');
});

test('injectionCmd on darwin escapes backslash in text', () => {
  const p = loadPlatformAs('darwin');
  const cmd = p.injectionCmd('C:\\path');
  const joined = cmd.args.join(' ');
  assert.ok(joined.includes('C:\\\\path'), 'backslash should be escaped');
});

test('injectionCmd on win32 returns powershell with SendKeys', () => {
  const p = loadPlatformAs('win32');
  const cmd = p.injectionCmd('hello');
  assert.strictEqual(cmd.bin, 'powershell');
  const joined = cmd.args.join(' ');
  assert.ok(joined.includes('SendKeys'), 'should use SendKeys');
  assert.ok(joined.includes('hello'), 'should include text');
});

test('injectionCmd on linux returns xdotool when present, null otherwise', () => {
  const p = loadPlatformAs('linux');
  const cmd = p.injectionCmd('hello');
  // xdotool may or may not be installed on the CI machine
  if (cmd !== null) {
    assert.strictEqual(cmd.bin, 'xdotool');
    assert.ok(cmd.args.includes('type'), 'should use type subcommand');
    assert.ok(cmd.args.includes('hello'), 'should include text');
  }
  // null is also valid — xdotool not installed
});

// --- hasBinary ---

test('hasBinary returns false for a nonexistent binary name', () => {
  const p = loadPlatformAs(process.platform);
  assert.strictEqual(p.hasBinary('__nonexistent_binary_xyz987__'), false);
});

test('hasBinary returns true for node (always present)', () => {
  const p = loadPlatformAs(process.platform);
  assert.strictEqual(p.hasBinary('node'), true);
});

// --- recorderConfig ---

test('recorderConfig returns object with bin and buildArgs function, or null', () => {
  const p = loadPlatformAs(process.platform);
  const rc = p.recorderConfig();
  if (rc !== null) {
    assert.strictEqual(typeof rc.bin, 'string');
    assert.strictEqual(typeof rc.buildArgs, 'function');
    const args = rc.buildArgs('/tmp/test.wav');
    assert.ok(Array.isArray(args), 'buildArgs should return array');
    assert.ok(args.includes('/tmp/test.wav') || args.some(a => a.includes('test.wav')),
      'buildArgs should include output path');
  }
  // null is valid when no recorder is installed
});

// --- sttConfig ---

test('sttConfig on darwin returns type swift', () => {
  const p = loadPlatformAs('darwin');
  const stt = p.sttConfig();
  assert.strictEqual(stt.type, 'swift');
  assert.strictEqual(typeof stt.buildCmd, 'function');
});

test('sttConfig on win32 returns type sapi', () => {
  const p = loadPlatformAs('win32');
  const stt = p.sttConfig();
  assert.strictEqual(stt.type, 'sapi');
  assert.strictEqual(typeof stt.buildCmd, 'function');
});

test('sttConfig on linux without vosk returns type none', () => {
  const p = loadPlatformAs('linux');
  const stt = p.sttConfig();
  // Either vosk or none — both are valid depending on what's installed
  assert.ok(['vosk', 'none'].includes(stt.type), `Unexpected stt.type: ${stt.type}`);
});

// --- whisperConfig ---

test('whisperConfig returns null when binary/model absent', () => {
  const p = loadPlatformAs(process.platform);
  // On a clean machine whisper is never present — result should be null.
  // If it IS installed (user ran setup --whisper), this test is a no-op.
  const wc = p.whisperConfig();
  if (wc !== null) {
    assert.strictEqual(typeof wc.bin, 'string');
    assert.strictEqual(typeof wc.buildArgs, 'function');
  }
});

(async () => {
  let passed = 0, failed = 0;
  console.log('platform');
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
