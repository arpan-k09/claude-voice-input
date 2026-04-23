// SPDX-License-Identifier: MIT
'use strict';

// Manages a presence marker in ~/.claude/settings.json so `status` and
// `uninstall` work correctly for the standalone CLI install path.
//
// Safety rules (all tested):
//   1. Backup before any mutation (timestamped .bak file).
//   2. Refuse malformed JSON — never clobber, error with instructions.
//   3. Atomic write: .tmp → rename, never leaves settings half-written.
//   4. Idempotent: re-running install when already present is zero-write.
//   5. Scoped: only read/replace/remove entries whose command includes MARKER.
//   6. Upgrade in place: stale path is replaced, not duplicated.
//
// We write a single PostToolUse hook whose command is a no-op node one-liner.
// This marker has no functional effect on Claude's behavior but gives
// `status` a reliable signal and gives `uninstall` something to remove.
// The node binary is guaranteed present since Claude Code requires it.

const fs = require('fs');
const path = require('path');
const os = require('os');

const MARKER = 'claude-voice-input';
const RUN_SCRIPT_ABS = path.resolve(__dirname, '..', 'bin', 'run.js');
const HOOK_COMMAND = `node ${JSON.stringify(RUN_SCRIPT_ABS)}`;
const MARKER_COMMAND = `node -e "// ${MARKER} marker"`;
const MARKER_EVENT = 'PostToolUse';

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
        if (h.command === command) return false; // already current, no change
        groups[i] = ourEntry;                    // upgrade stale entry in place
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

  const anyChanged = _upsertEventEntry(settings, MARKER_EVENT, MARKER_COMMAND);

  if (!anyChanged) {
    return { changed: false, backup: null, file, command: HOOK_COMMAND, events: [MARKER_EVENT] };
  }

  const backupPath = backup(file);
  atomicWrite(file, JSON.stringify(settings, null, 2) + '\n');
  return { changed: true, backup: backupPath, file, command: HOOK_COMMAND, events: [MARKER_EVENT] };
}

function uninstall({ home = os.homedir() } = {}) {
  const file = settingsPath(home);
  if (!fs.existsSync(file)) return { changed: false, backup: null, file };

  const settings = readSettings(file);
  if (!settings.hooks || typeof settings.hooks !== 'object') {
    return { changed: false, backup: null, file };
  }

  let changed = false;
  const allEvents = new Set(Object.keys(settings.hooks));
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
  install,
  uninstall,
  status,
  settingsPath,
  MARKER,
  HOOK_COMMAND,
  MARKER_COMMAND,
  MARKER_EVENT,
  _upsertEventEntry,
  readSettings,
  backup,
  atomicWrite,
};
