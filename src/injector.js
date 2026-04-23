// SPDX-License-Identifier: MIT
'use strict';

const { execFile } = require('child_process');
const platform = require('./platform');

const INJECT_TIMEOUT_MS = 5_000;

// Types `text` into the active terminal window using OS accessibility APIs.
// Throws if the injection binary is unavailable or the call fails.
async function inject(text) {
  if (!text || !text.trim()) return;

  const cmd = platform.injectionCmd(text);
  if (!cmd) {
    const hint = platform.PLATFORM === 'linux'
      ? ' Install xdotool: sudo apt install xdotool'
      : '';
    throw new Error(`Text injection not supported on ${platform.PLATFORM}.${hint}`);
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
