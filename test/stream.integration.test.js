// SPDX-License-Identifier: MIT
'use strict';

// Integration test for bin/stream.js with a mock `swift` and mock `osascript`.
// Each test generates a bespoke mock `swift` that emits a hardcoded sequence
// of P/F lines and then parks until SIGTERM. The mock `osascript` appends its
// argv to a log file we parse afterward. We spawn stream.js with PATH and HOME
// overridden so it picks up the mocks and writes its PID file into a sandbox.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const repoRoot = path.join(__dirname, '..');
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function makeSandbox(scriptedLines) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cvi-it-'));
  const mockBin = path.join(tmp, 'bin');
  fs.mkdirSync(mockBin);
  const fakeHome = path.join(tmp, 'home');
  fs.mkdirSync(fakeHome);
  const osaLog = path.join(tmp, 'osa.log');
  fs.writeFileSync(osaLog, '');

  // Bake the scripted lines directly into the mock — no env required.
  const linesJson = JSON.stringify(scriptedLines);
  const mockSwift = `#!/usr/bin/env node
const lines = ${linesJson};
const keepAlive = setInterval(() => {}, 1e6);
(async () => {
  for (const l of lines) {
    process.stdout.write(l + '\\n');
    await new Promise((r) => setTimeout(r, 40));
  }
})();
process.on('SIGTERM', () => { clearInterval(keepAlive); process.exit(0); });
`;
  fs.writeFileSync(path.join(mockBin, 'swift'), mockSwift, { mode: 0o755 });

  const mockOsa = `#!/usr/bin/env node
const fs = require('fs');
fs.appendFileSync(${JSON.stringify(osaLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');
process.exit(0);
`;
  fs.writeFileSync(path.join(mockBin, 'osascript'), mockOsa, { mode: 0o755 });

  return { tmp, mockBin, fakeHome, osaLog };
}

function runStream(sandbox, { killAfterMs = 1200 } = {}) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      PATH: sandbox.mockBin + ':' + process.env.PATH,
      HOME: sandbox.fakeHome,
    };
    const child = spawn('node', [path.join(repoRoot, 'bin', 'stream.js')], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
    }, killAfterMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      let raw = '';
      try { raw = fs.readFileSync(sandbox.osaLog, 'utf8'); } catch {}
      const osaCalls = raw.trim().split('\n').filter(Boolean).map(JSON.parse);
      resolve({ code, stderr, osaCalls, child });
    });
    resolve.child = child;
  });
}

function cleanup(sandbox) {
  try { fs.rmSync(sandbox.tmp, { recursive: true, force: true }); } catch {}
}

function keystrokeCalls(osaCalls) {
  return osaCalls.filter((a) => a.join(' ').includes('keystroke'));
}
function deleteCalls(osaCalls) {
  return osaCalls.filter((a) => a.join(' ').includes('key code 51'));
}

test('partial-only: types progressively, no backspaces', async () => {
  const sb = makeSandbox(['P hello', 'P hello world', 'P hello world today']);
  try {
    const res = await runStream(sb, { killAfterMs: 1500 });
    const k = keystrokeCalls(res.osaCalls);
    assert.ok(k.length >= 1, `expected ≥1 keystroke calls, got ${k.length}; stderr=${res.stderr}`);
    assert.ok(k[0].join(' ').includes('hello'), `first keystroke should type hello; got ${JSON.stringify(k[0])}`);
    assert.strictEqual(deleteCalls(res.osaCalls).length, 0, 'no backspaces on monotonic partials');
  } finally { cleanup(sb); }
});

test('refinement: issues backspaces then retype', async () => {
  const sb = makeSandbox(['P hello word', 'P hello world']);
  try {
    const res = await runStream(sb, { killAfterMs: 1500 });
    assert.ok(deleteCalls(res.osaCalls).length >= 1, `expected ≥1 backspace batch; stderr=${res.stderr}`);
    const k = keystrokeCalls(res.osaCalls);
    assert.ok(k.some((c) => c.join(' ').includes('ld')), 'should re-type ld after backspace');
  } finally { cleanup(sb); }
});

test('final boundary: freezes text; next partial appends after space', async () => {
  const sb = makeSandbox(['P hi', 'F hi.', 'P there']);
  try {
    const res = await runStream(sb, { killAfterMs: 1500 });
    const k = keystrokeCalls(res.osaCalls);
    assert.ok(k.some((c) => c.join(' ').includes('there')), 'should type partial after final');
  } finally { cleanup(sb); }
});

test('pid file created while running, removed on exit', async () => {
  const sb = makeSandbox(['P x']);
  try {
    const pidFile = path.join(sb.fakeHome, '.claude', 'claude-voice-input', 'current.pid');
    const p = runStream(sb, { killAfterMs: 600 });
    await new Promise((r) => setTimeout(r, 250));
    const existedMidRun = fs.existsSync(pidFile);
    await p;
    assert.ok(existedMidRun, 'pid file should exist while running');
    assert.ok(!fs.existsSync(pidFile), 'pid file should be removed after exit');
  } finally { cleanup(sb); }
});

(async () => {
  let passed = 0, failed = 0;
  console.log('stream integration');
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
