#!/usr/bin/env node
// SPDX-License-Identifier: MIT
'use strict';

// Invoked by the /voice-input slash command.
// Thin orchestrator: record → transcribe → inject, always cleans up temp file.

const recorder = require('../src/recorder');
const transcriber = require('../src/transcriber');
const injector = require('../src/injector');
const fs = require('fs');

const args = process.argv.slice(2);
const testMode = args.includes('--test');
const langIdx = args.indexOf('--lang');
if (langIdx !== -1 && args[langIdx + 1]) {
  process.env.VOICE_INPUT_LANG = args[langIdx + 1];
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
