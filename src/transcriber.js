// SPDX-License-Identifier: MIT
'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const platform = require('./platform');

const STT_TIMEOUT_MS = 15_000;

// Reads the opt-in config JSON; returns {} on missing/invalid.
function _readConfig() {
  try {
    return JSON.parse(fs.readFileSync(platform.configPath(), 'utf8'));
  } catch {
    return {};
  }
}

// Transcribes `audioFile` and returns a trimmed string.
// Selection order: whisper opt-in → platform default → error.
// Special case: if audioFile ends in .txt (Windows combined record+transcribe),
// its content is returned directly without running any STT.
async function transcribe(audioFile) {
  // Windows combined recorder writes transcript as text directly.
  if (audioFile.endsWith('.txt')) {
    try {
      return fs.readFileSync(audioFile, 'utf8').trim();
    } catch {
      return '';
    }
  }

  const cfg = _readConfig();

  if (cfg.whisper) {
    const wc = platform.whisperConfig();
    if (!wc) {
      throw new Error(
        'Whisper is enabled in config but the binary/model was not found at ' +
        platform.whisperDir() +
        '. Run: claude-voice-input setup --whisper'
      );
    }
    return _run(wc.bin, wc.buildArgs(audioFile));
  }

  const stt = platform.sttConfig();
  if (stt.type === 'none') {
    throw new Error(
      'No STT backend found. Options:\n' +
      '  Run: claude-voice-input setup --whisper   (downloads whisper.cpp tiny.en)\n' +
      '  Linux: pip install vosk  (then download a Vosk model)'
    );
  }

  const cmd = stt.buildCmd(audioFile);
  const text = await _run(cmd.bin, cmd.args);

  if (cmd.cleanup) {
    try { fs.unlinkSync(cmd.cleanup); } catch {}
  }

  return text;
}

function _run(bin, args) {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { timeout: STT_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) {
        if (err.killed) return reject(new Error(`STT timed out after ${STT_TIMEOUT_MS / 1000}s`));
        return reject(new Error(`STT (${bin}) failed: ${err.message}\nStderr: ${(stderr || '').slice(0, 200)}`));
      }
      resolve(stdout.trim());
    });
    if (child.stderr) child.stderr.on('data', () => {});
  });
}

module.exports = { transcribe, _readConfig, _run };
