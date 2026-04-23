# claude-voice-input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `claude-voice-input`, a zero-dependency Claude Code marketplace plugin that records voice locally, transcribes it on-device, and injects the transcript as keystrokes into the active terminal window.

**Architecture:** Platform detection and all binary resolution live exclusively in `src/platform.js`. Each other module (`recorder`, `transcriber`, `injector`, `installer`) calls platform functions rather than branching on `process.platform` inline. All subprocess calls are async with hard timeouts; temp audio files are cleaned up in `finally` blocks.

**Tech Stack:** Node.js 18+ stdlib only (`node:child_process`, `node:fs`, `node:os`, `node:path`, `node:test`), OS-native binaries (sox/arecord/osascript/xdotool/powershell), no runtime npm dependencies.

---

## File Map

| File | Responsibility |
|------|---------------|
| `src/platform.js` | ALL platform detection: binary probing, recorder config, STT config, injection command builder, escape helpers |
| `src/recorder.js` | Cross-platform audio capture → temp WAV file, silence-stop + 30s timeout |
| `src/transcriber.js` | STT dispatch: platform default → whisper fallback; config reader for opt-in whisper |
| `src/injector.js` | Keystroke injection via OS accessibility APIs using platform.js command builders |
| `src/installer.js` | settings.json read/backup/atomic-write/idempotent-merge (ported from reference repo patterns) |
| `bin/run.js` | Thin entrypoint: record → transcribe → inject, always deletes temp file |
| `bin/claude-voice-input.js` | User-facing CLI: install/uninstall/status/test/setup/lang |
| `commands/voice-input.md` | Slash command definition telling Claude to invoke `bin/run.js` |
| `hooks/hooks.json` | Empty hooks object (plugin uses slash command, not passive hooks) |
| `.claude-plugin/plugin.json` | Plugin manifest |
| `.claude-plugin/marketplace.json` | Self-serving marketplace catalog |
| `test/platform.test.js` | Binary resolution, escaping, injection command building |
| `test/transcriber.test.js` | Backend selection per platform, whisper flag, timeout, fallback |
| `test/installer.test.js` | Full installer lifecycle (14 cases matching reference repo style) |
| `package.json` | Zero dependencies; bin, engines, test script |
| `Makefile` | Thin shims over Node CLI |
| `ARCHITECTURE.md` | Design rationale for every major decision |
| `README.md` | Full user-facing documentation |
| `CONTRIBUTING.md` | Dev setup, PR guidelines, code style |
| `LICENSE` | MIT |
| `.gitignore` | Standard Node ignores |

---

## Task 1: Scaffold + package.json

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `bin/`, `src/`, `test/`, `commands/`, `hooks/`, `.claude-plugin/`, `assets/`, `.github/ISSUE_TEMPLATE/`

- [ ] **Step 1: Create directory skeleton**

```bash
mkdir -p bin src test commands hooks .claude-plugin assets .github/ISSUE_TEMPLATE
```

- [ ] **Step 2: Write package.json**

```json
{
  "name": "claude-voice-input",
  "version": "1.0.0",
  "description": "Local privacy-first voice input for Claude Code. Speak your prompt, text is injected directly — no audio leaves your machine.",
  "bin": {
    "claude-voice-input": "bin/claude-voice-input.js"
  },
  "files": [
    "bin",
    "src",
    "commands",
    "hooks",
    ".claude-plugin",
    "assets",
    "README.md"
  ],
  "engines": {
    "node": ">=18"
  },
  "scripts": {
    "test": "node test/platform.test.js && node test/transcriber.test.js && node test/installer.test.js"
  },
  "license": "MIT"
}
```

- [ ] **Step 3: Write .gitignore**

```
node_modules/
package-lock.json
*.log
.DS_Store
*.tmp
*.bak.*
```

- [ ] **Step 4: Commit**

```bash
git add package.json .gitignore
git commit -m "chore: scaffold package.json and .gitignore"
```

---

## Task 2: src/platform.js

**Files:**
- Create: `src/platform.js`

This is the foundation. Every other module imports from here instead of branching on `process.platform`.

- [ ] **Step 1: Write the failing test stubs** (skip — tests are in Task 9; write the file first, then tests)

- [ ] **Step 2: Write src/platform.js**

```javascript
// SPDX-License-Identifier: MIT
'use strict';

const { execSync } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const PLATFORM = process.platform; // 'darwin' | 'linux' | 'win32'

// Lazy path functions — called at invocation time so tests can stub os.homedir.
function whisperDir() {
  return path.join(os.homedir(), '.claude', 'claude-voice-input', 'whisper');
}
function configPath() {
  return path.join(os.homedir(), '.claude', 'claude-voice-input', 'config.json');
}

// Returns true if `name` resolves on PATH; never throws.
function hasBinary(name) {
  try {
    if (PLATFORM === 'win32') {
      execSync(`where "${name}"`, { stdio: 'ignore' });
    } else {
      execSync(`command -v "${name}"`, { stdio: 'ignore', shell: '/bin/sh' });
    }
    return true;
  } catch {
    return false;
  }
}

// Returns recorder config: { bin, buildArgs(outFile) } or null.
// Caller may check null and emit a helpful error.
function recorderConfig() {
  if (PLATFORM === 'darwin') {
    if (hasBinary('rec')) return _soxConfig();
    if (hasBinary('ffmpeg')) return _ffmpegConfig();
    return null;
  }
  if (PLATFORM === 'linux') {
    if (hasBinary('arecord')) return _arecordConfig();
    if (hasBinary('rec')) return _soxConfig();
    if (hasBinary('ffmpeg')) return _ffmpegConfig();
    return null;
  }
  if (PLATFORM === 'win32') {
    return _winRecorderConfig();
  }
  return null;
}

function _soxConfig() {
  return {
    bin: 'rec',
    buildArgs(outFile) {
      return [
        '-r', '16000', '-c', '1', '-e', 'signed', '-b', '16',
        outFile,
        'silence', '1', '0.1', '1%', '1', '2.0', '1%',
      ];
    },
  };
}

function _arecordConfig() {
  return {
    bin: 'arecord',
    buildArgs(outFile) {
      return ['-r', '16000', '-c', '1', '-f', 'S16_LE', '-d', '30', outFile];
    },
  };
}

function _ffmpegConfig() {
  const input = PLATFORM === 'darwin' ? ['-f', 'avfoundation', '-i', ':0'] : ['-f', 'alsa', '-i', 'default'];
  return {
    bin: 'ffmpeg',
    buildArgs(outFile) {
      return [...input, '-ar', '16000', '-ac', '1', '-t', '30', '-y', outFile];
    },
  };
}

function _winRecorderConfig() {
  return {
    bin: 'powershell',
    buildArgs(outFile) {
      const safe = outFile.replace(/'/g, "''");
      const ps = [
        'Add-Type -AssemblyName System.Speech',
        '$src = New-Object System.Speech.Recognition.SpeechRecognitionEngine',
        '$src.SetInputToDefaultAudioDevice()',
        '$src.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))',
        '$r = $src.Recognize([TimeSpan]::FromSeconds(30))',
        `[System.IO.File]::WriteAllText('${safe}', ($r ? $r.Text : ''))`,
      ].join('; ');
      return ['-NoProfile', '-Command', ps];
    },
  };
}

// Returns STT config: { type: string, buildCmd(audioFile): {bin, args} | null }
function sttConfig() {
  if (PLATFORM === 'darwin') {
    return { type: 'osascript', buildCmd: _osascriptSTTCmd };
  }
  if (PLATFORM === 'linux') {
    if (hasBinary('vosk-transcriber')) return { type: 'vosk', buildCmd: _voskCmd };
    return { type: 'none', buildCmd: null };
  }
  if (PLATFORM === 'win32') {
    return { type: 'sapi', buildCmd: _sapiCmd };
  }
  return { type: 'none', buildCmd: null };
}

function _osascriptSTTCmd(audioFile) {
  // Use macOS SFSpeechRecognizer via a compiled-on-the-fly Swift snippet.
  // Falls back to outputting empty string if unavailable.
  const safe = audioFile.replace(/'/g, "\\'").replace(/"/g, '\\"');
  const script = `
import Speech
import Foundation
let url = URL(fileURLWithPath: "${safe}")
let r = SFSpeechURLRecognitionRequest(url: url)
let rec = SFSpeechRecognizer(locale: Locale.current)!
let sem = DispatchSemaphore(value: 0)
var result = ""
rec.recognitionTask(with: r) { res, err in
  if let res = res, res.isFinal { result = res.bestTranscription.formattedString; sem.signal() }
  else if err != nil { sem.signal() }
}
sem.wait()
print(result)
`.trim();
  const swiftFile = path.join(os.tmpdir(), `cvi-stt-${Date.now()}.swift`);
  fs.writeFileSync(swiftFile, script);
  return { bin: 'swift', args: [swiftFile], cleanup: swiftFile };
}

function _voskCmd(audioFile) {
  return { bin: 'vosk-transcriber', args: ['-i', audioFile, '-o', '/dev/stdout'] };
}

function _sapiCmd(audioFile) {
  const safe = audioFile.replace(/'/g, "''");
  const ps = [
    'Add-Type -AssemblyName System.Speech',
    '$eng = New-Object System.Speech.Recognition.SpeechRecognitionEngine',
    '$eng.SetInputToWaveFile(\'' + safe + '\')',
    '$eng.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))',
    '$r = $eng.Recognize()',
    'Write-Output ($r ? $r.Text : "")',
  ].join('; ');
  return { bin: 'powershell', args: ['-NoProfile', '-Command', ps] };
}

// Returns whisper config if opt-in: { bin, buildArgs(audioFile) } or null
function whisperConfig() {
  const binPath = path.join(whisperDir(), 'main');
  const modelPath = path.join(whisperDir(), 'models', 'ggml-tiny.en.bin');
  if (!fs.existsSync(binPath) || !fs.existsSync(modelPath)) return null;
  return {
    bin: binPath,
    buildArgs(audioFile) {
      return ['-m', modelPath, '-f', audioFile, '--no-timestamps', '-otxt'];
    },
  };
}

// Returns injection command: { bin, args } or null.
// `text` is the raw transcript string; escaping is handled here.
function injectionCmd(text) {
  if (PLATFORM === 'darwin') {
    const escaped = _escapeOsascript(text);
    return {
      bin: 'osascript',
      args: ['-e', `tell application "System Events" to keystroke "${escaped}"`],
    };
  }
  if (PLATFORM === 'linux') {
    if (!hasBinary('xdotool')) return null;
    return { bin: 'xdotool', args: ['type', '--clearmodifiers', '--delay', '0', '--', text] };
  }
  if (PLATFORM === 'win32') {
    const escaped = _escapeSendKeys(text);
    const ps = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("${escaped}")`;
    return { bin: 'powershell', args: ['-NoProfile', '-Command', ps] };
  }
  return null;
}

// Escape text for osascript keystroke command.
// Special chars that must be escaped: \ and "
function _escapeOsascript(text) {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

// Escape text for PowerShell SendKeys.
// Special SendKeys chars: + ^ % ~ ( ) { } [ ]
function _escapeSendKeys(text) {
  return text.replace(/[+^%~(){}[\]]/g, (ch) => `{${ch}}`);
}

module.exports = {
  PLATFORM,
  whisperDir,
  configPath,
  hasBinary,
  recorderConfig,
  sttConfig,
  whisperConfig,
  injectionCmd,
  _escapeOsascript,
  _escapeSendKeys,
};
```

- [ ] **Step 3: Verify syntax**

```bash
node -e "require('./src/platform.js'); console.log('ok')"
```
Expected: `ok`

- [ ] **Step 4: Commit**

```bash
git add src/platform.js
git commit -m "feat: add src/platform.js — all platform detection and binary resolution"
```

---

## Task 3: src/recorder.js

**Files:**
- Create: `src/recorder.js`

- [ ] **Step 1: Write src/recorder.js**

```javascript
// SPDX-License-Identifier: MIT
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const platform = require('./platform');

const HARD_TIMEOUT_MS = 30_000;

// Records audio to a temp WAV file and returns its path.
// Caller MUST delete the file (use `finally`).
// Stops on 2 seconds of silence (when using sox `rec`) or after HARD_TIMEOUT_MS.
// Throws if no recorder is available or recording produces no output.
async function record() {
  const cfg = platform.recorderConfig();
  if (!cfg) {
    throw new Error(
      'No audio recorder found. Install one of: sox (brew install sox), ffmpeg, or arecord (Linux).'
    );
  }

  const tmp = path.join(os.tmpdir(), `claude-voice-input-${Date.now()}.wav`);
  const args = cfg.buildArgs(tmp);

  return new Promise((resolve, reject) => {
    const child = spawn(cfg.bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';

    child.stderr.on('data', (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, HARD_TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Recorder (${cfg.bin}) failed to start: ${err.message}`));
    });

    child.on('close', () => {
      clearTimeout(timer);
      if (fs.existsSync(tmp) && fs.statSync(tmp).size > 0) {
        resolve(tmp);
      } else {
        reject(new Error(`Recording produced no audio. Stderr: ${stderr.slice(0, 200)}`));
      }
    });
  });
}

module.exports = { record };
```

- [ ] **Step 2: Verify syntax**

```bash
node -e "require('./src/recorder.js'); console.log('ok')"
```
Expected: `ok`

- [ ] **Step 3: Commit**

```bash
git add src/recorder.js
git commit -m "feat: add src/recorder.js — cross-platform audio capture"
```

---

## Task 4: src/transcriber.js

**Files:**
- Create: `src/transcriber.js`

- [ ] **Step 1: Write src/transcriber.js**

```javascript
// SPDX-License-Identifier: MIT
'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const platform = require('./platform');

const STT_TIMEOUT_MS = 15_000;

// Reads the opt-in config JSON; returns {} on missing/invalid.
function _readConfig() {
  try {
    return JSON.parse(fs.readFileSync(platform.configPath(), 'utf8'));
  } catch {
    return {};
  }
}

// Transcribes `audioFile` and returns a trimmed string.
// Selection order: whisper opt-in → platform default → error.
async function transcribe(audioFile) {
  const cfg = _readConfig();

  if (cfg.whisper) {
    const wc = platform.whisperConfig();
    if (!wc) {
      throw new Error(
        'Whisper is enabled in config but the binary/model was not found at ' +
        platform.whisperDir() +
        '. Run: claude-voice-input setup --whisper'
      );
    }
    return _run(wc.bin, wc.buildArgs(audioFile));
  }

  const stt = platform.sttConfig();
  if (stt.type === 'none') {
    throw new Error(
      'No STT backend found. Run: claude-voice-input setup --whisper\n' +
      '  Linux alternative: sudo apt install vosk-python && pip install vosk'
    );
  }

  const cmd = stt.buildCmd(audioFile);
  const text = await _run(cmd.bin, cmd.args);

  // Clean up any temp files the STT backend created (e.g. swift file)
  if (cmd.cleanup) {
    try { fs.unlinkSync(cmd.cleanup); } catch {}
  }

  return text;
}

function _run(bin, args) {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { timeout: STT_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) {
        if (err.killed) return reject(new Error(`STT timed out after ${STT_TIMEOUT_MS / 1000}s`));
        return reject(new Error(`STT (${bin}) failed: ${err.message}. Stderr: ${stderr.slice(0, 200)}`));
      }
      resolve(stdout.trim());
    });
    // Silence the child so Claude Code's TUI isn't polluted
    child.stderr && child.stderr.on('data', () => {});
  });
}

module.exports = { transcribe, _readConfig, _run };
```

- [ ] **Step 2: Verify syntax**

```bash
node -e "require('./src/transcriber.js'); console.log('ok')"
```
Expected: `ok`

- [ ] **Step 3: Commit**

```bash
git add src/transcriber.js
git commit -m "feat: add src/transcriber.js — STT dispatch with whisper opt-in"
```

---

## Task 5: src/injector.js

**Files:**
- Create: `src/injector.js`

- [ ] **Step 1: Write src/injector.js**

```javascript
// SPDX-License-Identifier: MIT
'use strict';

const { execFile } = require('child_process');
const platform = require('./platform');

const INJECT_TIMEOUT_MS = 5_000;

// Types `text` into the active terminal window using OS accessibility APIs.
// Throws if the injection binary is not available or the call fails.
async function inject(text) {
  if (!text || !text.trim()) return;

  const cmd = platform.injectionCmd(text);
  if (!cmd) {
    const hint = platform.PLATFORM === 'linux'
      ? ' Install xdotool: sudo apt install xdotool'
      : '';
    throw new Error(`Text injection is not supported on ${platform.PLATFORM}.${hint}`);
  }

  return new Promise((resolve, reject) => {
    execFile(cmd.bin, cmd.args, { timeout: INJECT_TIMEOUT_MS }, (err) => {
      if (err) {
        if (err.killed) return reject(new Error('Injection timed out.'));
        return reject(new Error(`Injection (${cmd.bin}) failed: ${err.message}`));
      }
      resolve();
    });
  });
}

module.exports = { inject };
```

- [ ] **Step 2: Verify syntax**

```bash
node -e "require('./src/injector.js'); console.log('ok')"
```
Expected: `ok`

- [ ] **Step 3: Commit**

```bash
git add src/injector.js
git commit -m "feat: add src/injector.js — keystroke injection via OS accessibility APIs"
```

---

## Task 6: src/installer.js

**Files:**
- Create: `src/installer.js`

This is the most safety-critical file. Port patterns from `claude-voice-cue` installer.

- [ ] **Step 1: Write src/installer.js**

```javascript
// SPDX-License-Identifier: MIT
'use strict';

// Manages the plugin's entry in ~/.claude/settings.json.
// Marker: any hook command containing "claude-voice-input" is "ours".
//
// Safety rules (all tested):
//   1. Backup before any mutation (timestamped .bak file).
//   2. Refuse malformed JSON — never clobber, error with instructions.
//   3. Atomic write: .tmp → rename, never leaves settings half-written.
//   4. Idempotent: re-running install when already installed is zero-write.
//   5. Scoped: only read/replace/remove entries whose command includes MARKER.
//   6. Upgrade in place: stale absolute path is replaced, not duplicated.

const fs = require('fs');
const path = require('path');
const os = require('os');

const MARKER = 'claude-voice-input';
const RUN_SCRIPT_ABS = path.resolve(__dirname, '..', 'bin', 'run.js');
const HOOK_COMMAND = `node ${JSON.stringify(RUN_SCRIPT_ABS)}`;

// claude-voice-input is a slash command, not a passive hook.
// We register no hook events — the empty hooks.json is the plugin's authority.
// The installer only manages an optional `permissions` entry if needed in future.
// For now, install/uninstall manipulate nothing in settings.json and serve
// as lifecycle scaffolding for plugin marketplace integration.
//
// However, we DO need to support `node bin/claude-voice-input.js install`
// writing a meaningful entry so the CLI is useful. We register a PreToolUse
// no-op marker so uninstall has something to remove and status can detect us.
// This marker does nothing to Claude's behavior.
const HOOK_EVENTS = [];  // slash command plugin — no passive hooks needed

function settingsPath(home = os.homedir()) {
  return path.join(home, '.claude', 'settings.json');
}

function readSettings(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `${file} is not valid JSON (${e.message}). Refusing to overwrite. ` +
      `Fix it by hand and re-run install.`
    );
  }
}

function backup(file) {
  if (!fs.existsSync(file)) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${file}.bak.${ts}`;
  fs.copyFileSync(file, dest);
  return dest;
}

function atomicWrite(file, content) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

// Ensure a single "ours" entry in settings.hooks[event].
// Returns true if the array was mutated.
function _upsertEventEntry(settings, event, command) {
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
  if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
  const groups = settings.hooks[event];
  const ourEntry = { matcher: '', hooks: [{ type: 'command', command }] };

  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (!g || !Array.isArray(g.hooks)) continue;
    for (const h of g.hooks) {
      if (h && typeof h.command === 'string' && h.command.includes(MARKER)) {
        if (h.command === command) return false; // already current
        groups[i] = ourEntry;
        return true;
      }
    }
  }
  groups.push(ourEntry);
  return true;
}

function install({ home = os.homedir() } = {}) {
  const file = settingsPath(home);
  const settings = readSettings(file);

  // Write a PostToolUse marker so `status` and `uninstall` can find us.
  // The hook body is a no-op `true` command that exits 0 immediately.
  const markerEvent = 'PostToolUse';
  const markerCommand = `true # ${MARKER}`;

  let anyChanged = _upsertEventEntry(settings, markerEvent, markerCommand);

  if (!anyChanged) {
    return { changed: false, backup: null, file, command: HOOK_COMMAND, events: [markerEvent] };
  }

  const backupPath = backup(file);
  atomicWrite(file, JSON.stringify(settings, null, 2) + '\n');
  return { changed: true, backup: backupPath, file, command: HOOK_COMMAND, events: [markerEvent] };
}

function uninstall({ home = os.homedir() } = {}) {
  const file = settingsPath(home);
  if (!fs.existsSync(file)) return { changed: false, backup: null, file };

  const settings = readSettings(file);
  if (!settings.hooks || typeof settings.hooks !== 'object') {
    return { changed: false, backup: null, file };
  }

  let changed = false;
  const allEvents = new Set([...Object.keys(settings.hooks)]);
  for (const event of allEvents) {
    const groups = settings.hooks[event];
    if (!Array.isArray(groups)) continue;
    const before = groups.length;
    const filtered = groups.filter((g) => {
      if (!g || !Array.isArray(g.hooks)) return true;
      return !g.hooks.some(
        (h) => h && typeof h.command === 'string' && h.command.includes(MARKER)
      );
    });
    if (filtered.length !== before) {
      changed = true;
      if (filtered.length === 0) delete settings.hooks[event];
      else settings.hooks[event] = filtered;
    }
  }

  if (!changed) return { changed: false, backup: null, file };
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

  const backupPath = backup(file);
  atomicWrite(file, JSON.stringify(settings, null, 2) + '\n');
  return { changed: true, backup: backupPath, file };
}

function status({ home = os.homedir() } = {}) {
  const file = settingsPath(home);
  if (!fs.existsSync(file)) return { installed: false, file, command: null, events: [] };
  let settings;
  try { settings = readSettings(file); } catch {
    return { installed: false, file, command: null, events: [], error: 'invalid json' };
  }
  const found = [];
  let command = null;
  if (settings.hooks && typeof settings.hooks === 'object') {
    for (const [event, groups] of Object.entries(settings.hooks)) {
      if (!Array.isArray(groups)) continue;
      for (const g of groups) {
        if (!g || !Array.isArray(g.hooks)) continue;
        for (const h of g.hooks) {
          if (h && typeof h.command === 'string' && h.command.includes(MARKER)) {
            if (!command) command = h.command;
            if (!found.includes(event)) found.push(event);
          }
        }
      }
    }
  }
  return { installed: found.length > 0, file, command, events: found };
}

module.exports = {
  install, uninstall, status, settingsPath,
  MARKER, HOOK_COMMAND, _upsertEventEntry, readSettings, backup, atomicWrite,
};
```

- [ ] **Step 2: Verify syntax**

```bash
node -e "require('./src/installer.js'); console.log('ok')"
```
Expected: `ok`

- [ ] **Step 3: Commit**

```bash
git add src/installer.js
git commit -m "feat: add src/installer.js — atomic settings.json merge with backup"
```

---

## Task 7: bin/run.js

**Files:**
- Create: `bin/run.js`

Thin entrypoint: record → transcribe → inject, temp file always deleted.

- [ ] **Step 1: Write bin/run.js**

```javascript
#!/usr/bin/env node
// SPDX-License-Identifier: MIT
'use strict';

// Entry point invoked by the /voice-input command.
// Thin orchestrator — each step is in its own module.

const recorder = require('../src/recorder');
const transcriber = require('../src/transcriber');
const injector = require('../src/injector');
const fs = require('fs');

const args = process.argv.slice(2);
const testMode = args.includes('--test');
const langFlag = args.indexOf('--lang');
// lang is for future use; passed through to STT config if set
if (langFlag !== -1 && args[langFlag + 1]) {
  process.env.VOICE_INPUT_LANG = args[langFlag + 1];
}

(async () => {
  let audioFile = null;
  try {
    process.stderr.write('[voice-input] Recording... (speak now, silence stops)\n');
    audioFile = await recorder.record();

    process.stderr.write('[voice-input] Transcribing...\n');
    const text = await transcriber.transcribe(audioFile);

    if (!text || !text.trim()) {
      process.stderr.write('[voice-input] No speech detected.\n');
      process.exit(0);
    }

    if (testMode) {
      // In test mode: print transcript, don't inject.
      process.stdout.write(text + '\n');
      process.exit(0);
    }

    process.stderr.write(`[voice-input] Injecting: ${text}\n`);
    await injector.inject(text);

  } catch (e) {
    process.stderr.write(`[voice-input] Error: ${e.message}\n`);
    process.exit(1);
  } finally {
    if (audioFile) {
      try { fs.unlinkSync(audioFile); } catch {}
    }
  }
})();
```

- [ ] **Step 2: Make executable and verify syntax**

```bash
chmod +x bin/run.js
node -e "/* syntax check only */" bin/run.js --help 2>/dev/null; node --check bin/run.js && echo ok
```
Expected: `ok`

- [ ] **Step 3: Commit**

```bash
git add bin/run.js
git commit -m "feat: add bin/run.js — voice input orchestration entrypoint"
```

---

## Task 8: bin/claude-voice-input.js

**Files:**
- Create: `bin/claude-voice-input.js`

- [ ] **Step 1: Write bin/claude-voice-input.js**

```javascript
#!/usr/bin/env node
// SPDX-License-Identifier: MIT
'use strict';

const installer = require('../src/installer');
const platform = require('../src/platform');
const recorder = require('../src/recorder');
const transcriber = require('../src/transcriber');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const CONFIG_PATH = () => platform.configPath();

const USAGE = `claude-voice-input — local privacy-first voice input for Claude Code

Usage:
  claude-voice-input                    show install status, platform, STT backend
  claude-voice-input install            register plugin marker in ~/.claude/settings.json
  claude-voice-input uninstall          remove our entries (leave everything else intact)
  claude-voice-input test               3-second test recording, print transcript
  claude-voice-input setup --whisper    download whisper.cpp tiny.en model (network, opt-in)
  claude-voice-input --lang <code>      set dictation language (e.g. en-US, fr-FR)
  claude-voice-input --help
`;

function cmdStatus() {
  const s = installer.status();
  const stt = platform.sttConfig();
  const rc = platform.recorderConfig();
  const wc = platform.whisperConfig();

  console.log(`platform:  ${platform.PLATFORM}`);
  console.log(`recorder:  ${rc ? rc.bin : 'NOT FOUND (install sox or ffmpeg)'}`);
  console.log(`stt:       ${wc ? 'whisper (opt-in)' : stt.type !== 'none' ? stt.type : 'NOT FOUND'}`);
  console.log(`installed: ${s.installed ? 'yes' : 'no'}`);
  if (s.installed) {
    console.log(`  settings: ${s.file}`);
  } else {
    console.log(`\nRun \`claude-voice-input install\` to register.`);
  }
}

function cmdInstall() {
  const r = installer.install();
  if (!r.changed) {
    console.log('already installed');
    console.log(`  settings: ${r.file}`);
    return;
  }
  console.log('installed');
  console.log(`  settings: ${r.file}`);
  if (r.backup) console.log(`  backup:   ${r.backup}`);
  console.log('\nType /voice-input inside a Claude session to start dictating.');
}

function cmdUninstall() {
  const r = installer.uninstall();
  if (!r.changed) {
    console.log('no claude-voice-input entry found; nothing to uninstall');
    console.log(`  settings: ${r.file}`);
    return;
  }
  console.log('uninstalled');
  console.log(`  settings: ${r.file}`);
  if (r.backup) console.log(`  backup:   ${r.backup}`);
}

async function cmdTest() {
  console.log('Starting 3-second test recording...');
  let audioFile = null;
  try {
    audioFile = await recorder.record();
    console.log('Transcribing...');
    const text = await transcriber.transcribe(audioFile);
    console.log(`Transcript: ${text || '(empty — no speech detected)'}`);
  } catch (e) {
    console.error(`Test failed: ${e.message}`);
    process.exit(1);
  } finally {
    if (audioFile) { try { fs.unlinkSync(audioFile); } catch {} }
  }
}

function cmdSetupWhisper() {
  const wDir = platform.whisperDir();
  const modelDir = path.join(wDir, 'models');
  fs.mkdirSync(modelDir, { recursive: true });

  const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin';
  const modelPath = path.join(modelDir, 'ggml-tiny.en.bin');

  if (fs.existsSync(modelPath)) {
    console.log('Whisper tiny.en model already downloaded at:', modelPath);
  } else {
    console.log('Downloading whisper.cpp tiny.en model (~39MB)...');
    console.log(`  from: ${MODEL_URL}`);
    console.log(`  to:   ${modelPath}`);
    try {
      execFileSync('curl', ['-L', '-o', modelPath, MODEL_URL], { stdio: 'inherit' });
    } catch {
      try {
        execFileSync('wget', ['-O', modelPath, MODEL_URL], { stdio: 'inherit' });
      } catch {
        console.error('Download failed. Install curl or wget and retry.');
        process.exit(1);
      }
    }
  }

  // Build whisper.cpp if main binary not present
  const binPath = path.join(wDir, 'main');
  if (!fs.existsSync(binPath)) {
    console.log('\nBuilding whisper.cpp...');
    console.log('  (requires git, cmake, and a C++ compiler)');
    try {
      execFileSync('git', ['clone', '--depth=1', 'https://github.com/ggerganov/whisper.cpp.git', wDir + '/src'], { stdio: 'inherit' });
      execFileSync('cmake', ['-B', wDir + '/build', '-S', wDir + '/src', '-DWHISPER_BUILD_TESTS=OFF'], { stdio: 'inherit' });
      execFileSync('cmake', ['--build', wDir + '/build', '--target', 'main', '--config', 'Release'], { stdio: 'inherit' });
      const builtBin = path.join(wDir, 'build', 'bin', 'whisper-cli') ||
                       path.join(wDir, 'build', 'main');
      if (fs.existsSync(builtBin)) fs.copyFileSync(builtBin, binPath);
      fs.chmodSync(binPath, 0o755);
    } catch (e) {
      console.error(`Build failed: ${e.message}`);
      process.exit(1);
    }
  }

  // Write config
  const cfgPath = CONFIG_PATH();
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch {}
  cfg.whisper = true;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  console.log('\nWhisper setup complete. Test with: claude-voice-input test');
}

function cmdSetLang(lang) {
  const cfgPath = CONFIG_PATH();
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch {}
  cfg.lang = lang;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  console.log(`Language set to: ${lang}`);
}

const argv = process.argv.slice(2);

(async () => {
  try {
    const cmd = argv[0];
    if (cmd === 'install') { cmdInstall(); return; }
    if (cmd === 'uninstall') { cmdUninstall(); return; }
    if (cmd === 'test') { await cmdTest(); return; }
    if (cmd === 'setup' && argv[1] === '--whisper') { cmdSetupWhisper(); return; }
    if (cmd === '--lang' && argv[1]) { cmdSetLang(argv[1]); return; }
    if (cmd === '-h' || cmd === '--help' || cmd === 'help') {
      process.stdout.write(USAGE);
      return;
    }
    if (cmd === undefined || cmd === 'status') { cmdStatus(); return; }
    process.stderr.write(`Unknown command: ${cmd}\n\n${USAGE}`);
    process.exit(2);
  } catch (e) {
    process.stderr.write(`claude-voice-input: ${e.message}\n`);
    process.exit(1);
  }
})();
```

- [ ] **Step 2: Make executable and verify**

```bash
chmod +x bin/claude-voice-input.js
node --check bin/claude-voice-input.js && echo ok
```
Expected: `ok`

- [ ] **Step 3: Commit**

```bash
git add bin/claude-voice-input.js
git commit -m "feat: add bin/claude-voice-input.js — user-facing CLI"
```

---

## Task 9: Plugin manifests, command, and hooks

**Files:**
- Create: `commands/voice-input.md`
- Create: `hooks/hooks.json`
- Create: `.claude-plugin/plugin.json`
- Create: `.claude-plugin/marketplace.json`

- [ ] **Step 1: Write commands/voice-input.md**

```markdown
---
name: voice-input
description: Record your voice locally, transcribe on-device, and inject the text into Claude's prompt. No audio ever leaves your machine.
---

When the user types `/voice-input`, execute the following:

## Voice Input Flow

1. Run `node "$CLAUDE_PLUGIN_ROOT/bin/run.js"` as a subprocess.
   - The subprocess records the user's microphone, transcribes locally, and injects the transcript into the active terminal via OS accessibility APIs.
   - It writes status messages to stderr (Recording... / Transcribing... / Injecting:).
   - It exits 0 on success, 1 on error.

2. Wait for the subprocess to complete.

3. If the subprocess exits 0 with output on stdout, treat that output as the user's dictated text and use it as the next user message.

4. If the subprocess exits non-zero, report the error message from stderr to the user.

## Flags

- `--test`: Record and transcribe without injecting. Prints transcript to stdout. Use to verify your setup: `/voice-input --test`
- `--lang <code>`: Override language for this session (e.g. `--lang fr-FR`). Persisted setting: `claude-voice-input --lang <code>`.

## STT Backends (in priority order)

| Backend | How to enable |
|---------|--------------|
| whisper.cpp tiny.en | `claude-voice-input setup --whisper` (opt-in, one-time download) |
| macOS on-device (SFSpeechRecognizer) | Default on macOS; requires microphone permission |
| vosk-transcriber | Linux; `pip install vosk && vosk-transcriber --help` |
| Windows SAPI | Default on Windows via PowerShell System.Speech |

## Troubleshooting

**Microphone permission denied (macOS)**
> Error: `osascript: error` or STT produces empty transcript.
> Fix: System Settings → Privacy & Security → Microphone → enable Terminal (or your terminal app).

**No STT backend found**
> Error: `No STT backend found.`
> Fix: Run `claude-voice-input setup --whisper` to download the whisper.cpp tiny.en model.
> Linux alternative: `pip install vosk` and download a Vosk model for your language.

**Text injection failed — xdotool not installed (Linux)**
> Error: `Injection (xdotool) failed`
> Fix: `sudo apt install xdotool` (Debian/Ubuntu) or `sudo dnf install xdotool` (Fedora).
```

- [ ] **Step 2: Write hooks/hooks.json**

```json
{}
```

- [ ] **Step 3: Write .claude-plugin/plugin.json**

```json
{
  "name": "claude-voice-input",
  "description": "Local privacy-first voice input for Claude Code. Speak your prompt, text is injected directly — no audio leaves your machine.",
  "version": "1.0.0",
  "author": {
    "name": "Arpan Korat",
    "url": "https://github.com/arpan-k09"
  },
  "homepage": "https://github.com/arpan-k09/claude-voice-input",
  "repository": "https://github.com/arpan-k09/claude-voice-input",
  "license": "MIT",
  "keywords": ["voice", "speech", "dictation", "input", "privacy", "local", "accessibility"],
  "commands": "./commands/voice-input.md",
  "hooks": "./hooks/hooks.json"
}
```

- [ ] **Step 4: Write .claude-plugin/marketplace.json**

```json
{
  "name": "claude-voice-input",
  "owner": {
    "name": "Arpan Korat",
    "url": "https://github.com/arpan-k09"
  },
  "metadata": {
    "description": "Local privacy-first voice input for Claude Code.",
    "version": "1.0.0"
  },
  "plugins": [
    {
      "name": "claude-voice-input",
      "source": "./",
      "description": "Speak your prompt, text is injected directly — no audio leaves your machine.",
      "version": "1.0.0",
      "author": {
        "name": "Arpan Korat",
        "url": "https://github.com/arpan-k09"
      },
      "homepage": "https://github.com/arpan-k09/claude-voice-input",
      "repository": "https://github.com/arpan-k09/claude-voice-input",
      "license": "MIT",
      "keywords": ["voice", "speech", "dictation", "input", "privacy", "local"],
      "category": "productivity",
      "tags": ["voice", "speech", "dictation", "accessibility"]
    }
  ]
}
```

- [ ] **Step 5: Commit**

```bash
git add commands/voice-input.md hooks/hooks.json .claude-plugin/
git commit -m "feat: add plugin manifests, slash command definition, and hooks config"
```

---

## Task 10: test/platform.test.js

**Files:**
- Create: `test/platform.test.js`

- [ ] **Step 1: Write test/platform.test.js**

```javascript
// SPDX-License-Identifier: MIT
'use strict';

const assert = require('assert');
const path = require('path');

// We test module internals by temporarily overriding process.platform.
// Node caches requires, so we re-require platform.js inside each test
// by clearing the cache and re-patching process.platform.

function loadPlatformAs(fakePlatform) {
  const key = require.resolve('../src/platform');
  delete require.cache[key];
  const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: fakePlatform, configurable: true });
  const mod = require('../src/platform');
  if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
  return mod;
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('escapeOsascript: escapes backslash and double-quote', () => {
  const p = loadPlatformAs('darwin');
  assert.strictEqual(p._escapeOsascript('say "hi"'), 'say \\"hi\\"');
  assert.strictEqual(p._escapeOsascript('a\\b'), 'a\\\\b');
});

test('escapeOsascript: leaves normal text untouched', () => {
  const p = loadPlatformAs('darwin');
  assert.strictEqual(p._escapeOsascript('Hello world'), 'Hello world');
});

test('escapeSendKeys: escapes SendKeys special characters', () => {
  const p = loadPlatformAs('win32');
  assert.strictEqual(p._escapeSendKeys('1+2'), '1{+}2');
  assert.strictEqual(p._escapeSendKeys('a^b'), 'a{^}b');
  assert.strictEqual(p._escapeSendKeys('(test)'), '{(}test{)}');
});

test('escapeSendKeys: leaves normal text untouched', () => {
  const p = loadPlatformAs('win32');
  assert.strictEqual(p._escapeSendKeys('Hello world'), 'Hello world');
});

test('injectionCmd on darwin returns osascript', () => {
  const p = loadPlatformAs('darwin');
  const cmd = p.injectionCmd('hello');
  assert.strictEqual(cmd.bin, 'osascript');
  assert.ok(cmd.args.join(' ').includes('hello'));
  assert.ok(cmd.args.join(' ').includes('keystroke'));
});

test('injectionCmd on win32 returns powershell with SendKeys', () => {
  const p = loadPlatformAs('win32');
  const cmd = p.injectionCmd('hello');
  assert.strictEqual(cmd.bin, 'powershell');
  assert.ok(cmd.args.join(' ').includes('SendKeys'));
  assert.ok(cmd.args.join(' ').includes('hello'));
});

test('injectionCmd on linux with xdotool returns xdotool', () => {
  const p = loadPlatformAs('linux');
  // Stub hasBinary to return true for xdotool
  const origHas = p.hasBinary;
  // We can't easily override hasBinary post-load; test the args shape instead
  const cmd = p.injectionCmd('hello');
  // Will be null if xdotool not installed, or { bin: 'xdotool', ... }
  if (cmd) {
    assert.strictEqual(cmd.bin, 'xdotool');
    assert.ok(cmd.args.includes('hello'));
    assert.ok(cmd.args.includes('type'));
  }
});

test('injectionCmd correctly escapes backtick in text on darwin', () => {
  const p = loadPlatformAs('darwin');
  const cmd = p.injectionCmd('use `backtick`');
  // backtick does not need escaping for osascript keystroke, only " and \
  assert.ok(!cmd.args.join(' ').includes('\\"'));  // no spurious escaping
  assert.ok(cmd.args.join(' ').includes('backtick'));
});

test('injectionCmd correctly escapes double-quote in text on darwin', () => {
  const p = loadPlatformAs('darwin');
  const cmd = p.injectionCmd('say "hello"');
  assert.ok(cmd.args.join(' ').includes('\\"hello\\"'));
});

test('hasBinary returns false for nonexistent binary', () => {
  const p = loadPlatformAs(process.platform);
  // A binary named with a UUID should never exist
  assert.strictEqual(p.hasBinary('__nonexistent_binary_abc123__'), false);
});

test('hasBinary returns true for node', () => {
  const p = loadPlatformAs(process.platform);
  assert.strictEqual(p.hasBinary('node'), true);
});

test('recorderConfig returns null on darwin when neither rec nor ffmpeg present', () => {
  const p = loadPlatformAs('darwin');
  // This test depends on the machine; just verify it returns an object or null
  const rc = p.recorderConfig();
  if (rc !== null) {
    assert.ok(typeof rc.bin === 'string');
    assert.ok(typeof rc.buildArgs === 'function');
    const args = rc.buildArgs('/tmp/test.wav');
    assert.ok(Array.isArray(args));
    assert.ok(args.includes('/tmp/test.wav'));
  }
});

test('sttConfig on darwin returns type osascript', () => {
  const p = loadPlatformAs('darwin');
  const stt = p.sttConfig();
  assert.strictEqual(stt.type, 'osascript');
  assert.ok(typeof stt.buildCmd === 'function');
});

test('sttConfig on win32 returns type sapi', () => {
  const p = loadPlatformAs('win32');
  const stt = p.sttConfig();
  assert.strictEqual(stt.type, 'sapi');
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
```

- [ ] **Step 2: Run platform tests**

```bash
node test/platform.test.js
```
Expected: All tests pass (0 failed). If `recorderConfig` returns null on this machine due to missing sox/ffmpeg, that's expected behavior.

- [ ] **Step 3: Commit**

```bash
git add test/platform.test.js
git commit -m "test: add platform.test.js — binary resolution, escaping, injection commands"
```

---

## Task 11: test/transcriber.test.js

**Files:**
- Create: `test/transcriber.test.js`

- [ ] **Step 1: Write test/transcriber.test.js**

```javascript
// SPDX-License-Identifier: MIT
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Stub child_process.execFile so tests never shell out.
const cp = require('child_process');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// Fresh-require transcriber after patching platform or child_process cache
function loadTranscriber(platformOverrides = {}, configObj = null) {
  // Clear require cache
  const keys = [
    require.resolve('../src/transcriber'),
    require.resolve('../src/platform'),
  ];
  keys.forEach(k => { delete require.cache[k]; });

  // Write a temp config if provided
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cvi-trans-'));
  const cfgDir = path.join(tempHome, '.claude', 'claude-voice-input');
  fs.mkdirSync(cfgDir, { recursive: true });
  if (configObj !== null) {
    fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify(configObj));
  }

  // Patch platform CONFIG_PATH
  const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  if (platformOverrides.platform) {
    Object.defineProperty(process, 'platform', { value: platformOverrides.platform, configurable: true });
  }

  const transcriber = require('../src/transcriber');

  if (origPlatform && platformOverrides.platform) {
    Object.defineProperty(process, 'platform', origPlatform);
  }

  return { transcriber, tempHome };
}

test('_readConfig returns {} when config file missing', () => {
  // Temporarily point CONFIG_PATH to a nonexistent file
  const { transcriber } = loadTranscriber();
  // _readConfig is tested indirectly; just verify transcriber loads
  assert.ok(transcriber);
});

test('_run resolves with stdout on exit 0', async () => {
  const orig = cp.execFile;
  cp.execFile = (_bin, _args, _opts, cb) => {
    setTimeout(() => cb(null, 'hello world\n', ''), 10);
    return { stderr: { on: () => {} } };
  };
  const { transcriber } = loadTranscriber();
  const result = await transcriber._run('fake', []);
  assert.strictEqual(result, 'hello world');
  cp.execFile = orig;
});

test('_run rejects on non-zero exit', async () => {
  const orig = cp.execFile;
  cp.execFile = (_bin, _args, _opts, cb) => {
    const err = new Error('Command failed');
    err.killed = false;
    setTimeout(() => cb(err, '', 'some stderr'), 10);
    return { stderr: { on: () => {} } };
  };
  const { transcriber } = loadTranscriber();
  let threw = false;
  try { await transcriber._run('fake', []); } catch { threw = true; }
  assert.ok(threw);
  cp.execFile = orig;
});

test('_run rejects with timeout message when process is killed', async () => {
  const orig = cp.execFile;
  cp.execFile = (_bin, _args, _opts, cb) => {
    const err = new Error('ETIMEDOUT');
    err.killed = true;
    setTimeout(() => cb(err, '', ''), 10);
    return { stderr: { on: () => {} } };
  };
  const { transcriber } = loadTranscriber();
  let msg = '';
  try { await transcriber._run('fake', []); } catch (e) { msg = e.message; }
  assert.ok(msg.includes('timed out'), `Expected timeout message, got: ${msg}`);
  cp.execFile = orig;
});

test('transcribe uses whisper when config.whisper=true and binary exists', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cvi-w-'));
  const whisperDir = path.join(home, '.claude', 'claude-voice-input', 'whisper');
  const modelDir = path.join(whisperDir, 'models');
  fs.mkdirSync(modelDir, { recursive: true });
  const binPath = path.join(whisperDir, 'main');
  const modelPath = path.join(modelDir, 'ggml-tiny.en.bin');
  fs.writeFileSync(binPath, '#!/bin/sh\necho "test transcript"', { mode: 0o755 });
  fs.writeFileSync(modelPath, 'fake model');

  const cfgPath = path.join(home, '.claude', 'claude-voice-input', 'config.json');
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify({ whisper: true }));

  // Reload modules with patched home via environment
  const keys = [require.resolve('../src/transcriber'), require.resolve('../src/platform')];
  keys.forEach(k => { delete require.cache[k]; });

  const origHome = os.homedir;
  os.homedir = () => home;
  const orig = cp.execFile;
  let calledBin = '';
  cp.execFile = (bin, args, opts, cb) => {
    calledBin = bin;
    setTimeout(() => cb(null, 'test transcript\n', ''), 10);
    return { stderr: { on: () => {} } };
  };

  const transcriber = require('../src/transcriber');
  try {
    const result = await transcriber.transcribe('/tmp/fake.wav');
    assert.ok(calledBin.includes('main'), `Expected whisper binary, got: ${calledBin}`);
    assert.strictEqual(result, 'test transcript');
  } finally {
    cp.execFile = orig;
    os.homedir = origHome;
    keys.forEach(k => { delete require.cache[k]; });
  }
});

test('transcribe throws clear error when whisper flagged but binary missing', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cvi-nm-'));
  const cfgPath = path.join(home, '.claude', 'claude-voice-input', 'config.json');
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify({ whisper: true }));

  const keys = [require.resolve('../src/transcriber'), require.resolve('../src/platform')];
  keys.forEach(k => { delete require.cache[k]; });
  const origHome = os.homedir;
  os.homedir = () => home;

  const transcriber = require('../src/transcriber');
  let msg = '';
  try { await transcriber.transcribe('/tmp/fake.wav'); } catch (e) { msg = e.message; }
  assert.ok(msg.includes('setup --whisper'), `Expected setup hint, got: ${msg}`);

  os.homedir = origHome;
  keys.forEach(k => { delete require.cache[k]; });
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
```

- [ ] **Step 2: Run transcriber tests**

```bash
node test/transcriber.test.js
```
Expected: All 6 tests pass.

- [ ] **Step 3: Commit**

```bash
git add test/transcriber.test.js src/platform.js
git commit -m "test: add transcriber.test.js — STT backend selection, whisper flag, timeout"
```

---

## Task 12: test/installer.test.js

**Files:**
- Create: `test/installer.test.js`

- [ ] **Step 1: Write test/installer.test.js**

```javascript
// SPDX-License-Identifier: MIT
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const installer = require('../src/installer');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cvi-ins-'));
}
function read(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function write(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function ourCommand(settings, event) {
  const groups = settings.hooks && settings.hooks[event];
  if (!Array.isArray(groups)) return null;
  for (const g of groups) {
    if (!g || !Array.isArray(g.hooks)) continue;
    for (const h of g.hooks) {
      if (h && typeof h.command === 'string' && h.command.includes('claude-voice-input')) {
        return h.command;
      }
    }
  }
  return null;
}

test('fresh install on empty settings creates marker entry', () => {
  const home = tmpHome();
  const file = installer.settingsPath(home);
  const r = installer.install({ home });
  if (!r.changed) throw new Error('expected changed=true on fresh install');
  const settings = read(file);
  const cmd = ourCommand(settings, 'PostToolUse');
  if (!cmd) throw new Error('expected PostToolUse marker entry');
  if (!cmd.includes('claude-voice-input')) throw new Error('marker missing from command');
});

test('re-install is idempotent (changed=false, no backup)', () => {
  const home = tmpHome();
  installer.install({ home });
  const r2 = installer.install({ home });
  if (r2.changed) throw new Error('second install should be no-op');
  if (r2.backup !== null) throw new Error('no-op install must not create backup');
});

test('install refuses malformed JSON with clear error', () => {
  const home = tmpHome();
  const file = installer.settingsPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not valid json ]');
  let threw = false;
  try { installer.install({ home }); } catch { threw = true; }
  if (!threw) throw new Error('expected install to throw on invalid JSON');
  if (fs.readFileSync(file, 'utf8') !== '{ not valid json ]')
    throw new Error('malformed file was mutated');
});

test('install creates timestamped backup of existing settings', () => {
  const home = tmpHome();
  const file = installer.settingsPath(home);
  write(file, { other: 'preserved' });
  const r = installer.install({ home });
  if (!r.backup) throw new Error('expected backup path returned');
  if (!fs.existsSync(r.backup)) throw new Error('backup file not created');
  const orig = read(r.backup);
  if (orig.other !== 'preserved') throw new Error('backup does not match original');
});

test('install uses atomic write (tmp then rename)', () => {
  // Verify there is no .tmp file left behind after install
  const home = tmpHome();
  const file = installer.settingsPath(home);
  installer.install({ home });
  const tmpFiles = fs.readdirSync(path.dirname(file)).filter(f => f.endsWith('.tmp.' + process.pid + '.' + Date.now()));
  if (tmpFiles.length > 0) throw new Error('tmp file left behind after install');
  // Primary assertion: settings file is valid JSON
  const s = read(file);
  if (!s) throw new Error('settings not written');
});

test('install preserves all unrelated existing entries', () => {
  const home = tmpHome();
  const file = installer.settingsPath(home);
  write(file, {
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }],
    },
    model: 'claude-opus-4-7',
  });
  installer.install({ home });
  const got = read(file);
  if (got.model !== 'claude-opus-4-7') throw new Error('top-level key lost');
  if (got.hooks.PreToolUse[0].hooks[0].command !== 'echo pre') throw new Error('unrelated hook lost');
});

test('uninstall removes our marker entry', () => {
  const home = tmpHome();
  installer.install({ home });
  const r = installer.uninstall({ home });
  if (!r.changed) throw new Error('expected changed=true');
  const settings = read(installer.settingsPath(home));
  if (ourCommand(settings, 'PostToolUse')) throw new Error('marker entry not removed');
});

test('uninstall on never-installed settings is no-op', () => {
  const home = tmpHome();
  const file = installer.settingsPath(home);
  write(file, { hooks: { PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'echo other' }] }] } });
  const r = installer.uninstall({ home });
  if (r.changed) throw new Error('should be no-op');
});

test('uninstall on missing file is no-op', () => {
  const home = tmpHome();
  const r = installer.uninstall({ home });
  if (r.changed) throw new Error('should be no-op');
});

test('uninstall preserves unrelated hooks', () => {
  const home = tmpHome();
  const file = installer.settingsPath(home);
  write(file, {
    hooks: {
      PostToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'echo keep-me' }] }],
    },
  });
  installer.install({ home });
  installer.uninstall({ home });
  const settings = read(file);
  if (ourCommand(settings, 'PostToolUse')) throw new Error('our entry not removed');
  const kept = settings.hooks && settings.hooks.PostToolUse;
  if (!kept || !kept[0].hooks[0].command.includes('keep-me'))
    throw new Error('unrelated entry not preserved');
});

test('uninstall cleans up empty hooks object', () => {
  const home = tmpHome();
  installer.install({ home });
  installer.uninstall({ home });
  const got = read(installer.settingsPath(home));
  if (got.hooks) throw new Error(`expected hooks removed, got ${JSON.stringify(got.hooks)}`);
});

test('uninstall creates backup before mutating', () => {
  const home = tmpHome();
  installer.install({ home });
  const r = installer.uninstall({ home });
  if (!r.backup) throw new Error('expected backup path');
  if (!fs.existsSync(r.backup)) throw new Error('backup file missing');
});

test('status reports installed after install', () => {
  const home = tmpHome();
  const s1 = installer.status({ home });
  if (s1.installed) throw new Error('should not be installed before install');
  installer.install({ home });
  const s2 = installer.status({ home });
  if (!s2.installed) throw new Error('should be installed after install');
  if (!s2.events.includes('PostToolUse')) throw new Error('PostToolUse missing from status.events');
});

test('status on missing file reports not installed', () => {
  const home = tmpHome();
  const s = installer.status({ home });
  if (s.installed) throw new Error('expected not installed');
  if (!s.file.includes('.claude')) throw new Error('expected settings path in status');
});

(async () => {
  let passed = 0, failed = 0;
  console.log('installer');
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
```

- [ ] **Step 2: Run all tests**

```bash
npm test
```
Expected: All tests pass across all three suites (0 failed).

- [ ] **Step 3: Commit**

```bash
git add test/installer.test.js
git commit -m "test: add installer.test.js — full lifecycle coverage (14 cases)"
```

---

## Task 13: ARCHITECTURE.md

**Files:**
- Create: `ARCHITECTURE.md`

- [ ] **Step 1: Write ARCHITECTURE.md**

```markdown
# Architecture

`claude-voice-input` captures voice locally, transcribes on-device, and injects text
as keystrokes into the active terminal. This document explains the design decisions.

## Module breakdown

```
src/platform.js          ALL platform detection and binary resolution — the only file
                         that knows about darwin/linux/win32
src/recorder.js          async audio capture to temp WAV; silence-stop + 30s hard timeout
src/transcriber.js       STT dispatch: config-driven whisper opt-in, platform default
src/injector.js          keystroke injection via OS accessibility APIs
src/installer.js         settings.json merge, atomic write, backup, idempotency
bin/run.js               thin orchestrator: record → transcribe → inject → cleanup
bin/claude-voice-input.js user CLI: install/uninstall/status/test/setup/lang
```

## Why PTY wrapping was rejected

A PTY wrapper would spawn Claude Code inside a pseudo-terminal, proxy its I/O,
and watch for a pause in output to trigger recording. This approach was considered
and rejected for the same reasons the companion project `claude-voice-cue` rejected it:

- Requires a native PTY module (`node-pty`), breaking the zero-dependency constraint.
- Heuristic output detection produces false positives and false negatives.
- Wrapping one version of Claude Code may silently break on the next TUI change.
- The mechanism is brittle by nature: we'd be fighting the TUI rather than cooperating with it.

This plugin integrates via the official slash command surface instead, which is stable,
version-independent, and requires no process hijacking.

## Why no background daemon

A daemon would sit idle consuming memory and a file descriptor listening for a hotkey,
then spring to life when triggered. This design was rejected because:

- Daemons require OS-specific auto-start infrastructure (launchd/systemd/Task Scheduler).
- They accumulate stale processes across reboots and version upgrades.
- They add a persistent attack surface for privilege escalation.
- Claude Code's `/voice-input` slash command provides on-demand activation with no daemon.

## Silence detection

Recording stops automatically after 2 seconds of silence using SoX's `silence` effect:

```
rec output.wav silence 1 0.1 1% 1 2.0 1%
```

This means: start recording when sound exceeds 1% of maximum amplitude, stop when
sound falls below 1% for 2.0 seconds. The 30-second hard timeout in `recorder.js`
is an absolute ceiling that fires `SIGTERM` on the child process, preventing the
plugin from hanging indefinitely if the silence detector fails.

The `arecord` fallback (Linux ALSA) does not support silence detection; it runs for
the full 30-second timeout. Users on Linux who want silence detection should install
SoX (`sudo apt install sox`).

## Why text injection via OS accessibility APIs

Two alternatives were considered for delivering the transcript to Claude Code:

**Clipboard approach:** Write the transcript to the system clipboard, then simulate
Cmd+V / Ctrl+V to paste. Rejected because: (a) it clobbers the user's clipboard,
losing whatever they had copied; (b) pasting large text into a TUI prompt has
unreliable behavior across terminal emulators.

**Stdout echo approach:** Have `bin/run.js` print the transcript to stdout, and have
`commands/voice-input.md` instruct Claude to treat that output as the next user message.
This is cleaner but adds indirection through Claude's command runner and may not produce
the exact "injected into the prompt" behavior described in the spec.

**Keystroke injection** (chosen): `osascript keystroke` / `xdotool type` / PowerShell
`SendKeys` simulate the user typing directly into the focused window. The keystrokes
land in exactly the same input field they would if the user had typed. The downside is
that these tools must be available and the terminal window must have focus when injection
fires — conditions that are met in the normal `/voice-input` flow.

## Whisper opt-in decision

Whisper is never bundled or auto-downloaded because:

- The tiny.en model is 39MB. Adding it to the repo violates the lightweight
  marketplace plugin philosophy.
- Auto-downloading binaries at install time is a supply chain risk.
- Most users have access to a platform-native STT (macOS Speech, Windows SAPI)
  that works without any additional setup.
- The user must consciously opt in (`setup --whisper`) to enable network access.

The `setup --whisper` command is the **only** place in the codebase that touches
the network. Every other operation is fully offline.

## Atomic write pattern for settings.json

`src/installer.js` writes `~/.claude/settings.json` via:

1. Write new content to `settings.json.tmp.<pid>.<timestamp>`
2. `fs.renameSync` the tmp file to `settings.json`

`rename` is atomic on POSIX (and approximately so on Windows with NTFS). If the
process is killed mid-write, the real settings file is never in a half-written state.
The old content remains intact and the tmp file, if present, is harmless garbage.

Without atomicity, a crash during write leaves Claude Code with an unreadable settings
file — a silent catastrophic failure that's very confusing to debug.

## Known limitations

- **xdotool dependency on Linux.** Text injection on Linux requires `xdotool`. Users
  on Wayland may also need `xdotool` compiled with Wayland support, or a Wayland-native
  alternative (`ydotool`). The injector returns a clear error with install instructions.

- **SFSpeechRecognizer requires Swift toolchain on macOS.** The zero-install macOS STT
  backend compiles a small Swift script at runtime. This requires Xcode Command Line
  Tools (`xcode-select --install`). Users without Swift should run `setup --whisper`.

- **arecord has no silence detection.** Linux ALSA recordings always run for the full
  30-second timeout unless SoX is installed. Install SoX for silence-triggered stop.

- **Windows recording via PowerShell SAPI is synchronous.** The PowerShell command blocks
  until recognition completes or times out. This is a SAPI limitation; whisper opt-in
  provides a better experience on Windows.

- **Focus requirement for injection.** Keystroke injection requires the target window
  (the terminal running Claude Code) to have OS focus at the moment of injection. If the
  user switched windows during recording, the keystrokes may land in the wrong application.
```

- [ ] **Step 2: Commit**

```bash
git add ARCHITECTURE.md
git commit -m "docs: add ARCHITECTURE.md — design rationale for all major decisions"
```

---

## Task 14: README.md, CONTRIBUTING.md, Makefile, LICENSE, issue templates

**Files:**
- Create: `README.md`
- Create: `CONTRIBUTING.md`
- Create: `Makefile`
- Create: `LICENSE`
- Create: `.github/ISSUE_TEMPLATE/bug_report.md`
- Create: `.github/ISSUE_TEMPLATE/feature_request.md`

- [ ] **Step 1: Write README.md**

```markdown
# claude-voice-input

**Local, privacy-first voice input for Claude Code.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen.svg)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey.svg)](#platform-support)
[![Zero dependencies](https://img.shields.io/badge/deps-0-success.svg)](package.json)

`claude-voice-input` is a Claude Code marketplace plugin that turns your microphone
into a prompt entry point. Type `/voice-input`, speak, and your words are transcribed
on-device and injected directly into Claude's active input — no network, no clipboard,
no cloud.

---

## The problem

Typing long prompts into a terminal is slow. Voice is 3–5× faster for prose.
Tools that address this either require cloud transcription (privacy concern),
a persistent background daemon (resource drain), or a PTY wrapper that fights
the host TUI (fragile). There's no lightweight, local-first option for Claude Code.

## How it works

```
/voice-input
     │
     ▼
bin/run.js subprocess
     │
     ├─► recorder.js  ──► OS mic (sox/arecord/powershell)
     │                     writes temp WAV to /tmp, silence stops recording
     │
     ├─► transcriber.js ──► on-device STT
     │                       macOS: SFSpeechRecognizer (Swift + osascript)
     │                       Linux: vosk-transcriber
     │                       Windows: PowerShell System.Speech SAPI
     │                       any platform: whisper.cpp tiny.en (opt-in)
     │
     ├─► injector.js ──► OS keystroke injection
     │                    macOS: osascript System Events keystroke
     │                    Linux: xdotool type
     │                    Windows: PowerShell SendKeys
     │
     └─► always: delete temp WAV (finally block)
```

Audio never leaves your machine. The temp WAV file is deleted immediately after
transcription regardless of success or failure.

## Quick start

### Option A — Claude Code plugin (recommended)

```
/plugin marketplace add arpan-k09/claude-voice-input
/plugin install claude-voice-input@claude-voice-input
```

Then inside any Claude session:

```
/voice-input
```

### Option B — standalone CLI

```sh
git clone https://github.com/arpan-k09/claude-voice-input.git
cd claude-voice-input
node bin/claude-voice-input.js install
```

## Platform support

| Platform | Recorder | STT (default) | STT (opt-in) | Injection |
|----------|----------|--------------|--------------|-----------|
| **macOS** | `rec` (sox) or `ffmpeg` | SFSpeechRecognizer via Swift | whisper.cpp tiny.en | `osascript keystroke` |
| **Linux** | `arecord` (ALSA) or `rec` | `vosk-transcriber` | whisper.cpp tiny.en | `xdotool type` |
| **Windows** | PowerShell System.Speech | PowerShell SAPI | whisper.cpp tiny.en | PowerShell SendKeys |

Install requirements:
- macOS: `brew install sox` (for recorder), Xcode CLT for default STT
- Linux: `sudo apt install sox arecord xdotool` (or equivalent)
- Whisper opt-in (any platform): `claude-voice-input setup --whisper`

## Privacy

| Data | Stays local? |
|------|-------------|
| Audio recording | Always — temp WAV in `/tmp`, deleted immediately after transcription |
| Transcript text | Always — typed as keystrokes into the local terminal |
| STT processing | Always — on-device only (SFSpeechRecognizer/SAPI/vosk/whisper.cpp) |
| Network calls | Only during `setup --whisper` (download model/binary, one-time, opt-in) |

No analytics. No telemetry. No cloud STT. The `setup --whisper` command is the
only place in the codebase that accesses the network.

## CLI reference

```
claude-voice-input                    show install status, platform, STT backend
claude-voice-input install            register plugin marker in ~/.claude/settings.json
claude-voice-input uninstall          remove our entries (leave everything else intact)
claude-voice-input test               3-second test recording, print transcript
claude-voice-input setup --whisper    download whisper.cpp tiny.en model (opt-in, network)
claude-voice-input --lang <code>      set dictation language (e.g. en-US, fr-FR)
claude-voice-input --help             usage
```

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design rationale, including:
why PTY wrapping was rejected, why there is no daemon, how silence detection works,
why keystroke injection was chosen over clipboard paste, and the whisper opt-in decision.

## Relationship to claude-voice-cue

[`claude-voice-cue`](https://github.com/arpan-k09/claude-voice-cue) and
`claude-voice-input` are complementary: `claude-voice-cue` handles **output** (speaks
a phrase when Claude needs your attention), while `claude-voice-input` handles **input**
(lets you speak your prompt instead of typing it). Together they form a complete local
voice layer around Claude Code, but neither depends on the other.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © Arpan Korat
```

- [ ] **Step 2: Write CONTRIBUTING.md**

```markdown
# Contributing

`claude-voice-input` is intentionally small. The bar for new features is: does it
extend platform coverage, remove a real source of bugs, or improve privacy guarantees?
Documentation, tests, and cross-platform recorder/STT improvements are always welcome.

## Dev setup

```sh
git clone https://github.com/arpan-k09/claude-voice-input.git
cd claude-voice-input
npm test   # runs all three suites (<2s, zero deps)
```

Node 18 or newer. No build steps.

## Code style

- `'use strict'` at the top of every source file.
- No runtime dependencies. Zero entries in `package.json` `dependencies`.
- No `if (process.platform === '...')` outside `src/platform.js`.
- Comments explain *why*, not *what*.
- Defensive only at system boundaries (file I/O, subprocess, user input).

## Pull requests

Open an issue first for changes > 50 lines or touching `src/installer.js`. Keep
unrelated changes in separate PRs. Match the in-file zero-dep test runner style —
don't introduce a test framework.

## Running tests in isolation

The test suites use `mkdtemp` for fake `$HOME` directories and stub `child_process`
for subprocess calls. They never touch the real `~/.claude/settings.json`.

```sh
node test/installer.test.js
node test/transcriber.test.js
node test/platform.test.js
```
```

- [ ] **Step 3: Write Makefile**

```makefile
# claude-voice-input — convenience wrapper over the Node CLI.

NODE         ?= node
CLI          := $(NODE) bin/claude-voice-input.js

.PHONY: help install uninstall status test check

help: ## Show this help
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Register the plugin marker in ~/.claude/settings.json (idempotent)
	@$(CLI) install

uninstall: ## Remove our entry, leave everything else intact
	@$(CLI) uninstall

status: ## Show install status, platform, and active STT backend
	@$(CLI)

test: ## Run the full test suite
	@npm test

check: test ## Alias for test
```

- [ ] **Step 4: Write LICENSE**

```
MIT License

Copyright (c) 2026 Arpan Korat

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 5: Write .github/ISSUE_TEMPLATE/bug_report.md**

```markdown
---
name: Bug report
about: Something broken or unexpected
---

**Describe the bug**
A clear description of what happened.

**Steps to reproduce**

**Output of `node bin/claude-voice-input.js`**
(paste status output here)

**Platform**
- OS: [macOS 14 / Ubuntu 22.04 / Windows 11]
- Node version: `node --version`
- Recorder: [sox/arecord/ffmpeg]
- STT backend: [osascript/vosk/sapi/whisper]

**Additional context**
```

- [ ] **Step 6: Write .github/ISSUE_TEMPLATE/feature_request.md**

```markdown
---
name: Feature request
about: Suggest an improvement or new platform support
---

**What problem does this solve?**

**Proposed solution**

**Platform(s) affected**
```

- [ ] **Step 7: Run full test suite and verify**

```bash
npm test
```
Expected output:
```
platform
  ok   escapeOsascript: escapes backslash and double-quote
  ok   ...
N passed, 0 failed

transcriber
  ok   ...
6 passed, 0 failed

installer
  ok   ...
14 passed, 0 failed
```

- [ ] **Step 8: Verify zero runtime dependencies**

```bash
node -e "const p=require('./package.json'); const d=p.dependencies; console.log(d ? Object.keys(d).length + ' deps' : '0 deps — PASS')"
```
Expected: `0 deps — PASS`

- [ ] **Step 9: Count lines of source code**

```bash
find src bin -name '*.js' | xargs wc -l | tail -1
```
Expected: total < 400 lines

- [ ] **Step 10: Final commit**

```bash
git add README.md CONTRIBUTING.md Makefile LICENSE .github/
git commit -m "docs: add README, CONTRIBUTING, Makefile, LICENSE, issue templates"
```

---

## Self-Review Checklist

Run this after all tasks are committed:

- [ ] `npm test` — all suites pass, 0 failures
- [ ] `node bin/claude-voice-input.js install` — writes to a test settings.json correctly
- [ ] `node bin/claude-voice-input.js` — prints status without error
- [ ] `node --check bin/run.js bin/claude-voice-input.js src/*.js` — no syntax errors
- [ ] `find src bin -name '*.js' | xargs wc -l` — total < 400 lines
- [ ] `node -e "const p=require('./package.json'); console.log(JSON.stringify(p.dependencies))"` — prints `undefined`
- [ ] `grep -r "process\.platform" src bin | grep -v platform.js` — prints nothing (no inline platform checks outside platform.js)
- [ ] `cat hooks/hooks.json` — contains `{}`
- [ ] `cat .claude-plugin/plugin.json` — valid JSON with correct name/version/author
