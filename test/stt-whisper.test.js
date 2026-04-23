// SPDX-License-Identifier: MIT
'use strict';

// Tests stt-whisper.js's tokenize() and commitFromTranscript() logic — the
// append-only commit machinery. We require the module (which also bootstraps
// the recorder+whisper spawn); by setting mock env so the module's startup
// checks pass cleanly, then capturing stdout, we verify the commit behavior.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const repoRoot = path.join(__dirname, '..');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// Tokenize tests use the exported function directly with require() — but
// require() runs stt-whisper's top-level code which spawns sox. So we test
// tokenize via a subprocess that stubs sox/whisper, feeds transcripts, and
// logs the F lines. Easier: just reimplement-compare via unit import with
// the recorder not starting (we can set CVI_STT_CMD dry-run isn't provided).
//
// Simpler: spawn stt-whisper.js in a sandbox with mock `rec` and `whisper-cli`
// binaries on PATH, drive it with files, assert F-line output.

function makeSandbox() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cvi-wh-'));
  const mockBin = path.join(tmp, 'bin');
  fs.mkdirSync(mockBin);
  const fakeHome = path.join(tmp, 'home');
  fs.mkdirSync(fakeHome);
  const modelDir = path.join(fakeHome, '.claude', 'claude-voice-input', 'whisper', 'models');
  fs.mkdirSync(modelDir, { recursive: true });
  // whisperConfig requires the model file to exist — stub it.
  fs.writeFileSync(path.join(modelDir, 'ggml-tiny.en.bin'), 'stub');
  const wavFile = path.join(tmp, 'wav');
  const transcriptsFile = path.join(tmp, 'transcripts.txt');
  fs.writeFileSync(transcriptsFile, '');

  // Mock `rec` (sox): writes a growing WAV with enough bytes to pass MIN_BYTES.
  const mockRec = `#!/usr/bin/env node
const fs = require('fs');
const out = process.argv[process.argv.length - 1];
const fd = fs.openSync(out, 'w');
const chunk = Buffer.alloc(8192);
const iv = setInterval(() => {
  try { fs.writeSync(fd, chunk); } catch {}
}, 100);
process.on('SIGTERM', () => { clearInterval(iv); try { fs.closeSync(fd); } catch {} process.exit(0); });
`;
  fs.writeFileSync(path.join(mockBin, 'rec'), mockRec, { mode: 0o755 });

  // Mock whisper-cli: reads the next transcript from transcripts.txt (one per
  // line), writes it to the <wav>.txt file next to the input wav.
  const mockWhisper = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const argv = process.argv.slice(2);
const fIdx = argv.indexOf('-f');
if (fIdx === -1) process.exit(1);
const wav = argv[fIdx + 1];
const txt = wav + '.txt';
const file = ${JSON.stringify(transcriptsFile)};
let lines = [];
try { lines = fs.readFileSync(file, 'utf8').split('\\n').filter(Boolean); } catch {}
const cursorFile = file + '.cursor';
let cursor = 0;
try { cursor = parseInt(fs.readFileSync(cursorFile, 'utf8'), 10) || 0; } catch {}
const line = cursor < lines.length ? lines[cursor] : (lines[lines.length - 1] || '');
fs.writeFileSync(cursorFile, String(cursor + 1));
fs.writeFileSync(txt, line);
process.exit(0);
`;
  fs.writeFileSync(path.join(mockBin, 'whisper-cli'), mockWhisper, { mode: 0o755 });

  return { tmp, mockBin, fakeHome, transcriptsFile };
}

function writeTranscripts(file, transcripts) {
  fs.writeFileSync(file, transcripts.join('\n') + '\n');
  try { fs.unlinkSync(file + '.cursor'); } catch {}
}

function runStt(sandbox, { killAfterMs = 6500 } = {}) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      PATH: sandbox.mockBin + ':' + process.env.PATH,
      HOME: sandbox.fakeHome,
    };
    const child = spawn('node', [path.join(repoRoot, 'bin', 'stt-whisper.js')], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} }, killAfterMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      const fLines = stdout.split('\n').filter((l) => l.startsWith('F ')).map((l) => l.slice(2));
      resolve({ code, stdout, stderr, fLines });
    });
  });
}

function cleanup(sb) { try { fs.rmSync(sb.tmp, { recursive: true, force: true }); } catch {} }

test('monotonic growth commits append-only with one hold-back word', async () => {
  const sb = makeSandbox();
  try {
    writeTranscripts(sb.transcriptsFile, [
      'hello',
      'hello world',
      'hello world how',
      'hello world how are you',
    ]);
    const res = await runStt(sb, { killAfterMs: 8500 });
    // With HOLD_WORDS=1, each pass commits all but the last word.
    // Final pass (on SIGTERM) commits the rest.
    // Expected incremental emissions (one F per commit event):
    //   pass 1 "hello": 0 new committed (held back the only word)
    //   pass 2 "hello world": commit ["hello"] → "F hello"
    //   pass 3 "hello world how": commit ["world"] → "F world"
    //   pass 4 "hello world how are you": commit ["how", "are"] → "F how are"
    //   final: commit ["you"] → "F you"
    // The exact pass boundaries depend on timing so we just check append-only invariants.
    const concatenated = res.fLines.join(' ').replace(/\s+/g, ' ').trim();
    assert.strictEqual(concatenated, 'hello world how are you',
      `expected smooth append to "hello world how are you", got ${JSON.stringify(res.fLines)}`);
  } finally { cleanup(sb); }
});

test('divergence in earlier text is ignored (no backspace)', async () => {
  const sb = makeSandbox();
  try {
    writeTranscripts(sb.transcriptsFile, [
      'hello world how',
      'hi world how',        // whisper reinterpreted "hello"→"hi"; should be ignored
      'hello world how are', // back on track
      'hello world how are you there',
    ]);
    const res = await runStt(sb, { killAfterMs: 9500 });
    const concatenated = res.fLines.join(' ').replace(/\s+/g, ' ').trim();
    // We should never have "hi" in the committed output.
    assert.ok(!concatenated.split(' ').includes('hi'),
      `divergent word "hi" leaked: ${JSON.stringify(res.fLines)}`);
    // The happy-path words from consistent passes should show up.
    assert.ok(concatenated.includes('hello'), 'should commit "hello"');
    assert.ok(concatenated.includes('world'), 'should commit "world"');
  } finally { cleanup(sb); }
});

test('whisper bracket annotations like [BLANK_AUDIO] are stripped', async () => {
  const sb = makeSandbox();
  try {
    writeTranscripts(sb.transcriptsFile, [
      'hello [BLANK_AUDIO] world',
      'hello [BLANK_AUDIO] world today',
      'hello world today friend',
    ]);
    const res = await runStt(sb, { killAfterMs: 8500 });
    const concatenated = res.fLines.join(' ').replace(/\s+/g, ' ').trim();
    assert.ok(!concatenated.includes('BLANK_AUDIO'),
      `bracket annotation leaked: ${JSON.stringify(res.fLines)}`);
    assert.ok(concatenated.includes('hello'), 'should commit "hello"');
    assert.ok(concatenated.includes('world'), 'should commit "world"');
  } finally { cleanup(sb); }
});

(async () => {
  let passed = 0, failed = 0;
  console.log('stt-whisper');
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
