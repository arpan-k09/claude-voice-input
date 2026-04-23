#!/usr/bin/env node
// SPDX-License-Identifier: MIT
'use strict';

// Streaming voice input orchestrator (macOS V1).
// Spawns the Swift streaming STT helper, reads P/F lines, diffs against
// what's been typed, and issues osascript keystroke calls to update the prompt.
// Writes ~/.claude/claude-voice-input/current.pid so the UserPromptSubmit hook
// can SIGTERM this process when the user presses Enter.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const platform = require('../src/platform');
const { diff } = require('../src/stream-diff');

const DEBOUNCE_MS = 150;
const pidFile = path.join(os.homedir(), '.claude', 'claude-voice-input', 'current.pid');

function ensurePidDir() {
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
}

function writePid() {
  ensurePidDir();
  fs.writeFileSync(pidFile, String(process.pid));
}

function clearPid() {
  try { fs.unlinkSync(pidFile); } catch {}
}

function takeOverIfRunning() {
  try {
    const prior = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    if (prior && prior !== process.pid) {
      try { process.kill(prior, 'SIGTERM'); } catch {}
    }
  } catch {}
}

// osascript keystroke helpers
function osascriptKeystroke(text) {
  return new Promise((resolve) => {
    const escaped = platform._escapeOsascript(text);
    const child = spawn('osascript', [
      '-e',
      `tell application "System Events" to keystroke "${escaped}"`,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    child.on('exit', () => resolve());
    child.on('error', () => resolve());
  });
}

function osascriptDelete(n) {
  if (n <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const child = spawn('osascript', [
      '-e',
      `tell application "System Events" to repeat ${n} times
         key code 51
       end repeat`,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    child.on('exit', () => resolve());
    child.on('error', () => resolve());
  });
}

// Queue of updates; we coalesce: only the latest pending update survives.
let typedText = '';
let pending = null; // the next target text
let flushing = false;
let lastFlush = 0;
let finalPrefix = ''; // accumulated finalized text from prior segments

async function applyDiff(target) {
  const d = diff(typedText, target);
  if (d.backspaces === 0 && d.insert === '') return;
  if (d.backspaces > 0) await osascriptDelete(d.backspaces);
  if (d.insert) await osascriptKeystroke(d.insert);
  typedText = target;
}

async function flushLoop() {
  if (flushing) return;
  flushing = true;
  try {
    while (pending !== null) {
      const now = Date.now();
      const wait = Math.max(0, DEBOUNCE_MS - (now - lastFlush));
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      const target = pending;
      pending = null;
      await applyDiff(target);
      lastFlush = Date.now();
    }
  } finally {
    flushing = false;
  }
}

function schedule(target) {
  pending = target;
  flushLoop();
}

function onPartial(text) {
  schedule(finalPrefix + text);
}

function onFinal(text) {
  // Commit: fold this segment into finalPrefix with a trailing space so
  // subsequent partials for the next segment append naturally.
  finalPrefix = finalPrefix + text + ' ';
  schedule(finalPrefix);
}

let shuttingDown = false;

async function shutdown(swiftChild) {
  if (shuttingDown) return;
  shuttingDown = true;
  try { swiftChild && swiftChild.kill('SIGTERM'); } catch {}
  // Wait briefly for pending flush to drain so the prompt ends in a consistent state.
  const deadline = Date.now() + 800;
  while ((pending !== null || flushing) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  clearPid();
  process.exit(0);
}

function main() {
  const locale = process.env.VOICE_INPUT_LANG || 'en-US';
  const cmd = platform.swiftStreamCmd(locale);

  takeOverIfRunning();
  writePid();

  const child = spawn(cmd.bin, cmd.args, { stdio: ['ignore', 'pipe', 'pipe'] });

  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    if (line.startsWith('P ')) onPartial(line.slice(2));
    else if (line.startsWith('F ')) onFinal(line.slice(2));
  });

  child.stderr.on('data', (buf) => {
    process.stderr.write('[voice-input] ' + buf.toString());
  });

  child.on('exit', (code) => {
    if (cmd.cleanup) { try { fs.unlinkSync(cmd.cleanup); } catch {} }
    if (shuttingDown) return; // shutdown() owns the exit in this path
    clearPid();
    process.exit(code === 0 ? 0 : (code || 1));
  });

  process.on('SIGTERM', () => shutdown(child));
  process.on('SIGINT', () => shutdown(child));
}

if (require.main === module) main();

module.exports = { main, diff, _schedule: schedule, _onPartial: onPartial, _onFinal: onFinal };
