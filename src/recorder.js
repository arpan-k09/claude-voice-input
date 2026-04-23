// SPDX-License-Identifier: MIT
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const platform = require('./platform');

const HARD_TIMEOUT_MS = 30_000;

// Records audio to a temp WAV file and returns its absolute path.
// Caller MUST delete the file (use `finally`).
// Stops on 2 seconds of silence (sox rec) or after HARD_TIMEOUT_MS.
// Throws if no recorder is available or recording produces no output.
async function record() {
  const cfg = platform.recorderConfig();
  if (!cfg) {
    throw new Error(
      'No audio recorder found. Install one of:\n' +
      '  macOS/Linux: brew install sox   or   sudo apt install sox\n' +
      '  any platform: install ffmpeg'
    );
  }

  const ext = cfg._combined ? '.txt' : '.wav';
  const tmp = path.join(os.tmpdir(), `claude-voice-input-${Date.now()}${ext}`);
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
        reject(new Error(
          `Recording produced no audio. Check microphone permissions.\n` +
          `Recorder stderr: ${stderr.slice(0, 300)}`
        ));
      }
    });
  });
}

module.exports = { record };
