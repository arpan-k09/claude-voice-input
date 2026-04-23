#!/usr/bin/env node
// SPDX-License-Identifier: MIT
'use strict';

const installer = require('../src/installer');
const platform = require('../src/platform');
const recorder = require('../src/recorder');
const transcriber = require('../src/transcriber');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const USAGE = `claude-voice-input — local privacy-first voice input for Claude Code

Usage:
  claude-voice-input                    show install status, platform, STT backend
  claude-voice-input install            register plugin marker in ~/.claude/settings.json
  claude-voice-input uninstall          remove our entries (leave everything else intact)
  claude-voice-input test               3-second test recording, print transcript
  claude-voice-input setup --whisper    download whisper.cpp tiny.en model (opt-in, network)
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
  console.log(`stt:       ${wc ? 'whisper (opt-in active)' : stt.type !== 'none' ? stt.type : 'NOT FOUND'}`);
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
  console.log('Starting test recording...');
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
    let downloaded = false;
    for (const [bin, args] of [
      ['curl', ['-L', '-o', modelPath, MODEL_URL]],
      ['wget', ['-O', modelPath, MODEL_URL]],
    ]) {
      try {
        execFileSync(bin, args, { stdio: 'inherit' });
        downloaded = true;
        break;
      } catch {}
    }
    if (!downloaded) {
      console.error('Download failed. Install curl or wget and retry.');
      process.exit(1);
    }
  }

  const binPath = path.join(wDir, 'main');
  if (!fs.existsSync(binPath)) {
    console.log('\nBuilding whisper.cpp binary...');
    console.log('  (requires git, cmake, and a C++ compiler)');
    const srcDir = path.join(wDir, 'src');
    const buildDir = path.join(wDir, 'build');
    try {
      execFileSync('git', ['clone', '--depth=1', 'https://github.com/ggerganov/whisper.cpp.git', srcDir], { stdio: 'inherit' });
      execFileSync('cmake', ['-B', buildDir, '-S', srcDir, '-DWHISPER_BUILD_TESTS=OFF'], { stdio: 'inherit' });
      execFileSync('cmake', ['--build', buildDir, '--target', 'main', '--config', 'Release'], { stdio: 'inherit' });
      const candidates = [
        path.join(buildDir, 'bin', 'whisper-cli'),
        path.join(buildDir, 'bin', 'main'),
        path.join(buildDir, 'main'),
      ];
      const built = candidates.find((c) => fs.existsSync(c));
      if (built) { fs.copyFileSync(built, binPath); fs.chmodSync(binPath, 0o755); }
      else throw new Error('Could not locate built binary in ' + buildDir);
    } catch (e) {
      console.error(`Build failed: ${e.message}`);
      process.exit(1);
    }
  }

  const cfgPath = platform.configPath();
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch {}
  cfg.whisper = true;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  console.log('\nWhisper setup complete. Test with: claude-voice-input test');
}

function cmdSetLang(lang) {
  const cfgPath = platform.configPath();
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
    if (cmd === '-h' || cmd === '--help' || cmd === 'help') { process.stdout.write(USAGE); return; }
    if (cmd === undefined || cmd === 'status') { cmdStatus(); return; }
    process.stderr.write(`Unknown command: ${cmd}\n\n${USAGE}`);
    process.exit(2);
  } catch (e) {
    process.stderr.write(`claude-voice-input: ${e.message}\n`);
    process.exit(1);
  }
})();
