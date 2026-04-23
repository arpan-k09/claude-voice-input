#!/usr/bin/env node
// SPDX-License-Identifier: MIT
'use strict';

// UserPromptSubmit hook. When the user presses Enter in the Claude Code prompt,
// this runs. If bin/stream.js is currently recording, SIGTERM it so recording
// stops at submission. Must exit fast — never block prompt submission.

const fs = require('fs');
const path = require('path');
const os = require('os');

const pidFile = path.join(os.homedir(), '.claude', 'claude-voice-input', 'current.pid');

try {
  const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
  if (pid) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  try { fs.unlinkSync(pidFile); } catch {}
} catch {
  // No PID file or unreadable — nothing to stop.
}
process.exit(0);
