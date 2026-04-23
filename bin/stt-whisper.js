#!/usr/bin/env node
// SPDX-License-Identifier: MIT
'use strict';

// Whisper-based streaming STT helper (append-only, no jitter).
// Pipeline:
//   1. sox records continuously (no silence detection) to a growing WAV file.
//   2. Every POLL_MS we run whisper-cli on the current WAV.
//   3. We keep a list of "committed" words. Each pass, we check that the new
//      transcript begins with the committed prefix; if it does, the new words
//      beyond the prefix — minus the last HOLD_WORDS — are emitted as "F"
//      (final, append-to-prompt) lines and added to the commit list.
//      If the new transcript DIVERGES from our committed words (whisper
//      changed its mind about earlier text), we skip that pass and keep what
//      we already have. No backspaces, no jitter.
//   4. On SIGTERM: stop sox, run whisper one last time, commit everything
//      (including held-back words), exit.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const platform = require('../src/platform');

const POLL_MS = 2000;    // run whisper every 2s
const MIN_BYTES = 48000; // ~1.5s at 16kHz mono 16-bit PCM
const HOLD_WORDS = 1;    // hold back this many trailing words each pass

function die(code, msg) {
  process.stderr.write(msg + '\n');
  process.exit(code);
}

const rec = platform.continuousRecorderConfig();
if (!rec) die(3, 'No continuous recorder found. Install sox: brew install sox');

const wc = platform.whisperConfig();
if (!wc) die(2,
  'Whisper is not set up. Install whisper-cpp and download the model:\n' +
  '  brew install whisper-cpp\n' +
  '  mkdir -p ~/.claude/claude-voice-input/whisper/models\n' +
  '  curl -L -o ~/.claude/claude-voice-input/whisper/models/ggml-tiny.en.bin \\\n' +
  '    https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin'
);

const wavFile = path.join(os.tmpdir(), `cvi-live-${process.pid}.wav`);
const recorder = spawn(rec.bin, rec.buildArgs(wavFile), {
  stdio: ['ignore', 'ignore', 'pipe'],
});
recorder.stderr.on('data', () => {});

let whisperRunning = false;
let stopping = false;
let committed = []; // array of words already emitted as F and visible in prompt

// Run whisper-cli on the current WAV, parse the produced .txt, return transcript.
function runWhisper() {
  return new Promise((resolve) => {
    if (!fs.existsSync(wavFile)) return resolve('');
    if (fs.statSync(wavFile).size < MIN_BYTES) return resolve('');

    const txtFile = wavFile + '.txt';
    try { fs.unlinkSync(txtFile); } catch {}

    const child = spawn(wc.bin, wc.buildArgs(wavFile), {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr.on('data', () => {});
    child.on('error', () => resolve(''));
    child.on('exit', () => {
      let text = '';
      try { text = fs.readFileSync(txtFile, 'utf8'); } catch {}
      try { fs.unlinkSync(txtFile); } catch {}
      resolve(text);
    });
  });
}

// whisper annotates non-speech chunks with bracketed markers like
// [BLANK_AUDIO], [MUSIC], ( silence ), etc. Strip them before we tokenize.
function tokenize(raw) {
  return raw
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

// Commit new words from a whisper transcript. When `finalize` is true we
// commit all remaining words (including held-back ones). Returns the number
// of words we emitted this pass.
function commitFromTranscript(raw, finalize) {
  const words = tokenize(raw);
  if (words.length === 0) return 0;

  // Divergence check: new transcript must start with the committed prefix.
  // If it doesn't, whisper reinterpreted earlier text — we ignore this pass
  // to preserve what the user has already seen.
  for (let i = 0; i < committed.length; i += 1) {
    if (words[i] !== committed[i]) return 0;
  }

  const hold = finalize ? 0 : HOLD_WORDS;
  const end = Math.max(committed.length, words.length - hold);
  if (end <= committed.length) return 0;

  const newWords = words.slice(committed.length, end);
  // stream.js's onFinal handler appends a trailing space of its own, so we
  // just emit the bare words with no leading/trailing whitespace.
  process.stdout.write('F ' + newWords.join(' ') + '\n');
  committed = committed.concat(newWords);
  return newWords.length;
}

async function tick() {
  if (stopping || whisperRunning) return;
  whisperRunning = true;
  try {
    const text = await runWhisper();
    if (stopping || !text) return;
    commitFromTranscript(text, false);
  } finally {
    whisperRunning = false;
  }
}

const poller = setInterval(tick, POLL_MS);

async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(poller);

  try { recorder.kill('SIGTERM'); } catch {}
  await new Promise((r) => setTimeout(r, 250));

  const deadline = Date.now() + 5000;
  while (whisperRunning && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }

  const text = await runWhisper();
  if (text) commitFromTranscript(text, true);

  try { fs.unlinkSync(wavFile); } catch {}
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

recorder.on('exit', () => { if (!stopping) shutdown(); });

module.exports = { tokenize, commitFromTranscript, _getCommitted: () => committed.slice() };
