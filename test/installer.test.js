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

// Find the first command in settings.hooks[event] that contains our marker.
function ourCommand(settings, event) {
  const groups = settings.hooks && settings.hooks[event];
  if (!Array.isArray(groups)) return null;
  for (const g of groups) {
    if (!g || !Array.isArray(g.hooks)) continue;
    for (const h of g.hooks) {
      if (h && typeof h.command === 'string' && h.command.includes(installer.MARKER)) {
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
  const cmd = ourCommand(settings, installer.MARKER_EVENT);
  if (!cmd) throw new Error(`expected ${installer.MARKER_EVENT} marker entry`);
  if (!cmd.includes(installer.MARKER)) throw new Error('marker string missing from command');
});

test('re-install is idempotent — changed=false, no backup', () => {
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

test('install uses atomic write — settings file is valid JSON after install', () => {
  const home = tmpHome();
  installer.install({ home });
  const file = installer.settingsPath(home);
  // Should parse cleanly (atomic write ensures no partial state)
  const s = read(file);
  if (!s) throw new Error('settings not written or not valid JSON');
  // No .tmp files left behind for this process
  const dir = path.dirname(file);
  const tmpFiles = fs.readdirSync(dir).filter(f => f.includes('.tmp.'));
  if (tmpFiles.length > 0) throw new Error(`tmp file(s) left behind: ${tmpFiles.join(', ')}`);
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
  if (!got.hooks.PreToolUse || got.hooks.PreToolUse[0].hooks[0].command !== 'echo pre')
    throw new Error('unrelated PreToolUse hook lost');
});

test('install upgrade: replaces stale command in place, no duplicate', () => {
  const home = tmpHome();
  const file = installer.settingsPath(home);
  write(file, {
    hooks: {
      [installer.MARKER_EVENT]: [
        { matcher: '', hooks: [{ type: 'command', command: `node /old/path/${installer.MARKER}/bin/run.js` }] },
      ],
    },
  });
  const r = installer.install({ home });
  if (!r.changed) throw new Error('expected changed=true on upgrade');
  const settings = read(file);
  if (settings.hooks[installer.MARKER_EVENT].length !== 1)
    throw new Error('duplicate entry created on upgrade');
  const cmd = ourCommand(settings, installer.MARKER_EVENT);
  if (cmd.includes('/old/path/')) throw new Error('stale path not replaced');
});

test('uninstall removes our marker entry', () => {
  const home = tmpHome();
  installer.install({ home });
  const r = installer.uninstall({ home });
  if (!r.changed) throw new Error('expected changed=true');
  const settings = read(installer.settingsPath(home));
  if (ourCommand(settings, installer.MARKER_EVENT))
    throw new Error('marker entry not removed after uninstall');
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
  if (r.changed) throw new Error('should be no-op on missing file');
});

test('uninstall preserves unrelated hooks on same event', () => {
  const home = tmpHome();
  const file = installer.settingsPath(home);
  write(file, {
    hooks: {
      [installer.MARKER_EVENT]: [
        { matcher: '', hooks: [{ type: 'command', command: 'echo keep-me' }] },
      ],
    },
  });
  installer.install({ home });
  installer.uninstall({ home });
  const settings = read(file);
  if (ourCommand(settings, installer.MARKER_EVENT))
    throw new Error('our entry not removed');
  const kept = settings.hooks && settings.hooks[installer.MARKER_EVENT];
  if (!kept || kept[0].hooks[0].command !== 'echo keep-me')
    throw new Error('unrelated entry not preserved');
});

test('uninstall cleans up empty hooks object from settings', () => {
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

test('status reports installed=true after install, installed=false before', () => {
  const home = tmpHome();
  const s1 = installer.status({ home });
  if (s1.installed) throw new Error('should not be installed before install');
  installer.install({ home });
  const s2 = installer.status({ home });
  if (!s2.installed) throw new Error('should be installed after install');
  if (!s2.events.includes(installer.MARKER_EVENT))
    throw new Error(`${installer.MARKER_EVENT} missing from status.events`);
  if (!s2.command || !s2.command.includes(installer.MARKER))
    throw new Error('status.command missing marker');
});

test('status on missing file returns installed=false with correct path', () => {
  const home = tmpHome();
  const s = installer.status({ home });
  if (s.installed) throw new Error('expected not installed');
  if (!s.file.endsWith('settings.json')) throw new Error('expected settings path in status');
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
