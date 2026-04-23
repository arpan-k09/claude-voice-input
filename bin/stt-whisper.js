#!/usr/bin/env node
// SPDX-License-Identifier: MIT
'use strict';

// Whisper-based streaming STT helper.
// Pipeline:
//   1. sox records continuously (no silence detection) to a growing WAV file.
//   2. Every POLL_MS, if whisper-cli is not already running, run it on the
//      current WAV and emit "P <text>" if the transcript changed.
//   3. On SIGTERM: stop sox, run whisper one last time, emit "F <text>", exit.
//
// Output contract (stdout): one line per emission, "P <text>" or "F <text>".
// Errors go to stderr. Used by bin/stream.js on macOS.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const platform = require('../src/platform');

const POLL_MS = 1500;       // run whisper every 1.5s
const MIN_BYTES = 48000;    // require at least ~1.5s of 16kHz mono 16-bit PCM
                             // (actually: 16000 * 2 = 32000 B/s; 1.5s ≈ 48000 B)

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

let recorder = spawn(rec.bin, rec.buildArgs(wavFile), {
  stdio: ['ignore', 'ignore', 'pipe'],
});
recorder.stderr.on('data', () => {}); // swallow sox's progress output

let whisperRunning = false;
let lastEmitted = '';
let stopping = false;

// Run whisper-cli on the current WAV, parse the produced .txt, return transcript.
function runWhisper() {
  return new Promise((resolve) => {
    if (!fs.existsSync(wavFile)) return resolve('');
    const size = fs.statSync(wavFile).size;
    if (size < MIN_BYTES) return resolve('');

    const txtFile = wavFile + '.txt';
    try { fs.unlinkSync(txtFile); } catch {}

    const child = spawn(wc.bin, wc.buildArgs(wavFile), {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr.on('data', () => {}); // whisper is chatty; suppress
    child.on('error', () => resolve(''));
    child.on('exit', () => {
      let text = '';
      try { text = fs.readFileSync(txtFile, 'utf8').replace(/\s+/g, ' ').trim(); } catch {}
      try { fs.unlinkSync(txtFile); } catch {}
      resolve(text);
    });
  });
}

async function tick() {
  if (stopping || whisperRunning) return;
  whisperRunning = true;
  try {
    const text = await runWhisper();
    if (!stopping && text && text !== lastEmitted) {
      lastEmitted = text;
      process.stdout.write('P ' + text + '\n');
    }
  } finally {
    whisperRunning = false;
  }
}

const poller = setInterval(tick, POLL_MS);

async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(poller);

  // Stop sox and wait briefly for it to finalize the WAV.
  try { recorder.kill('SIGTERM'); } catch {}
  await new Promise((r) => setTimeout(r, 250));

  // Wait for any in-flight whisper to finish, then run one final pass.
  const deadline = Date.now() + 5000;
  while (whisperRunning && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const text = await runWhisper();
  if (text) process.stdout.write('F ' + text + '\n');

  try { fs.unlinkSync(wavFile); } catch {}
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

recorder.on('exit', () => { if (!stopping) shutdown(); });
