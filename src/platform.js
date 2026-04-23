// SPDX-License-Identifier: MIT
'use strict';

const { execSync } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const PLATFORM = process.platform; // 'darwin' | 'linux' | 'win32'

// Lazy path functions — called at invocation time so tests can stub os.homedir.
function whisperDir() {
  return path.join(os.homedir(), '.claude', 'claude-voice-input', 'whisper');
}
function configPath() {
  return path.join(os.homedir(), '.claude', 'claude-voice-input', 'config.json');
}

// Returns true if `name` resolves on PATH; never throws.
function hasBinary(name) {
  try {
    if (PLATFORM === 'win32') {
      execSync(`where "${name}"`, { stdio: 'ignore' });
    } else {
      execSync(`command -v "${name}"`, { stdio: 'ignore', shell: '/bin/sh' });
    }
    return true;
  } catch {
    return false;
  }
}

// Returns recorder config: { bin, buildArgs(outFile) } or null.
function recorderConfig() {
  if (PLATFORM === 'darwin') {
    if (hasBinary('rec')) return _soxConfig();
    if (hasBinary('ffmpeg')) return _ffmpegConfig();
    return null;
  }
  if (PLATFORM === 'linux') {
    if (hasBinary('arecord')) return _arecordConfig();
    if (hasBinary('rec')) return _soxConfig();
    if (hasBinary('ffmpeg')) return _ffmpegConfig();
    return null;
  }
  if (PLATFORM === 'win32') {
    if (hasBinary('ffmpeg')) return _ffmpegConfig();
    return _winRecorderConfig();
  }
  return null;
}

function _soxConfig() {
  return {
    bin: 'rec',
    buildArgs(outFile) {
      return [
        '-r', '16000', '-c', '1', '-e', 'signed', '-b', '16',
        outFile,
        'silence', '1', '0.1', '1%', '1', '2.0', '1%',
      ];
    },
  };
}

function _arecordConfig() {
  return {
    bin: 'arecord',
    buildArgs(outFile) {
      return ['-r', '16000', '-c', '1', '-f', 'S16_LE', '-d', '30', outFile];
    },
  };
}

function _ffmpegConfig() {
  let inputArgs;
  if (PLATFORM === 'darwin') inputArgs = ['-f', 'avfoundation', '-i', ':0'];
  else if (PLATFORM === 'win32') inputArgs = ['-f', 'dshow', '-i', 'audio=default'];
  else inputArgs = ['-f', 'alsa', '-i', 'default'];
  return {
    bin: 'ffmpeg',
    buildArgs(outFile) {
      return [...inputArgs, '-ar', '16000', '-ac', '1', '-t', '30', '-y', outFile];
    },
  };
}

// Windows fallback: uses PowerShell System.Speech to record+transcribe in one step.
// Writes the transcript as plain text to outFile (a .txt, despite the .wav name).
// transcriber.js detects this "combined" result via the _WIN_COMBINED marker.
function _winRecorderConfig() {
  return {
    bin: 'powershell',
    _combined: true, // signals transcriber to read outFile as text directly
    buildArgs(outFile) {
      const safe = outFile.replace(/'/g, "''");
      const ps = [
        'Add-Type -AssemblyName System.Speech',
        '$eng = New-Object System.Speech.Recognition.SpeechRecognitionEngine',
        '$eng.SetInputToDefaultAudioDevice()',
        '$eng.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))',
        '$r = $eng.Recognize([TimeSpan]::FromSeconds(30))',
        `[System.IO.File]::WriteAllText('${safe}', ($r ? $r.Text : ''))`,
      ].join('; ');
      return ['-NoProfile', '-Command', ps];
    },
  };
}

// Returns STT config: { type: string, buildCmd(audioFile): {bin, args} | null }
function sttConfig() {
  if (PLATFORM === 'darwin') {
    return { type: 'swift', buildCmd: _swiftSTTCmd };
  }
  if (PLATFORM === 'linux') {
    if (hasBinary('vosk-transcriber')) return { type: 'vosk', buildCmd: _voskCmd };
    return { type: 'none', buildCmd: null };
  }
  if (PLATFORM === 'win32') {
    return { type: 'sapi', buildCmd: _sapiCmd };
  }
  return { type: 'none', buildCmd: null };
}

function _swiftSTTCmd(audioFile) {
  const safeAudio = audioFile.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = `
import Speech
import Foundation
let url = URL(fileURLWithPath: "${safeAudio}")
let req = SFSpeechURLRecognitionRequest(url: url)
guard let rec = SFSpeechRecognizer(locale: Locale(identifier: "en-US")), rec.isAvailable else {
    print("")
    exit(0)
}
let sem = DispatchSemaphore(value: 0)
var result = ""
rec.recognitionTask(with: req) { res, err in
    if err != nil { sem.signal(); return }
    guard let res = res else { sem.signal(); return }
    if res.isFinal { result = res.bestTranscription.formattedString; sem.signal() }
}
_ = sem.wait(timeout: .now() + 13.0)
print(result)
`.trim();
  const swiftFile = path.join(os.tmpdir(), `cvi-stt-${Date.now()}.swift`);
  fs.writeFileSync(swiftFile, script);
  return { bin: 'swift', args: [swiftFile], cleanup: swiftFile };
}

function _voskCmd(audioFile) {
  return { bin: 'vosk-transcriber', args: ['-i', audioFile, '-o', '/dev/stdout'] };
}

function _sapiCmd(audioFile) {
  const safe = audioFile.replace(/'/g, "''");
  const ps = [
    'Add-Type -AssemblyName System.Speech',
    `$eng = New-Object System.Speech.Recognition.SpeechRecognitionEngine`,
    `$eng.SetInputToWaveFile('${safe}')`,
    `$eng.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))`,
    `$r = $eng.Recognize()`,
    `Write-Output ($r ? $r.Text : "")`,
  ].join('; ');
  return { bin: 'powershell', args: ['-NoProfile', '-Command', ps] };
}

// Returns the Swift source for the streaming STT helper used by bin/stream.js.
// Reads mic via AVAudioEngine, runs SFSpeechAudioBufferRecognitionRequest with
// partial results, emits one line per update to stdout:
//   "P <text>\n" for partial results
//   "F <text>\n" for final (segment boundary) results
// Runs until SIGTERM. Prints errors to stderr and exits non-zero on failure.
function streamSttScript(locale) {
  const safeLocale = (locale || 'en-US').replace(/"/g, '\\"');
  return `
import Speech
import AVFoundation
import Foundation

let stderr = FileHandle.standardError
let stdout = FileHandle.standardOutput
func logErr(_ s: String) { stderr.write((s + "\\n").data(using: .utf8)!) }
func emit(_ s: String) { stdout.write(s.data(using: .utf8)!) }

let authSem = DispatchSemaphore(value: 0)
var authStatus: SFSpeechRecognizerAuthorizationStatus = .notDetermined
SFSpeechRecognizer.requestAuthorization { s in authStatus = s; authSem.signal() }
authSem.wait()
guard authStatus == .authorized else {
    logErr("Speech recognition not authorized. Grant access in System Settings > Privacy & Security > Speech Recognition.")
    exit(2)
}

guard let rec = SFSpeechRecognizer(locale: Locale(identifier: "${safeLocale}")), rec.isAvailable else {
    logErr("SFSpeechRecognizer unavailable for locale ${safeLocale}.")
    exit(3)
}

let engine = AVAudioEngine()
let req = SFSpeechAudioBufferRecognitionRequest()
req.shouldReportPartialResults = true

let input = engine.inputNode
let fmt = input.outputFormat(forBus: 0)
input.installTap(onBus: 0, bufferSize: 1024, format: fmt) { buffer, _ in
    req.append(buffer)
}

engine.prepare()
do {
    try engine.start()
} catch {
    logErr("AVAudioEngine start failed: \\(error.localizedDescription)")
    exit(4)
}

var lastEmitted = ""
let task = rec.recognitionTask(with: req) { res, err in
    if let err = err {
        logErr("Recognition error: \\(err.localizedDescription)")
        return
    }
    guard let res = res else { return }
    let text = res.bestTranscription.formattedString
    if text == lastEmitted && !res.isFinal { return }
    lastEmitted = text
    let prefix = res.isFinal ? "F " : "P "
    emit(prefix + text + "\\n")
}

let termSrc = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
termSrc.setEventHandler {
    engine.stop()
    input.removeTap(onBus: 0)
    req.endAudio()
    task.cancel()
    exit(0)
}
signal(SIGTERM, SIG_IGN)
termSrc.resume()

let intSrc = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
intSrc.setEventHandler {
    engine.stop()
    input.removeTap(onBus: 0)
    req.endAudio()
    task.cancel()
    exit(0)
}
signal(SIGINT, SIG_IGN)
intSrc.resume()

RunLoop.main.run()
`.trim();
}

// Returns command to launch the streaming STT Swift helper.
// Writes the Swift source to a temp file, returns {bin, args, cleanup}.
function swiftStreamCmd(locale) {
  const script = streamSttScript(locale);
  const swiftFile = path.join(os.tmpdir(), `cvi-stream-${Date.now()}.swift`);
  fs.writeFileSync(swiftFile, script);
  return { bin: 'swift', args: [swiftFile], cleanup: swiftFile };
}

// Returns whisper config if opt-in binary+model exist: { bin, buildArgs(audioFile) } or null.
function whisperConfig() {
  const binPath = path.join(whisperDir(), 'main');
  const modelPath = path.join(whisperDir(), 'models', 'ggml-tiny.en.bin');
  if (!fs.existsSync(binPath) || !fs.existsSync(modelPath)) return null;
  return {
    bin: binPath,
    buildArgs(audioFile) {
      return ['-m', modelPath, '-f', audioFile, '--no-timestamps', '-otxt'];
    },
  };
}

// Returns injection command: { bin, args } or null.
// Escaping of `text` is handled here; callers pass raw strings.
function injectionCmd(text) {
  if (PLATFORM === 'darwin') {
    const escaped = _escapeOsascript(text);
    return {
      bin: 'osascript',
      args: ['-e', `tell application "System Events" to keystroke "${escaped}"`],
    };
  }
  if (PLATFORM === 'linux') {
    if (!hasBinary('xdotool')) return null;
    return { bin: 'xdotool', args: ['type', '--clearmodifiers', '--delay', '0', '--', text] };
  }
  if (PLATFORM === 'win32') {
    const escaped = _escapeSendKeys(text);
    const ps = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("${escaped}")`;
    return { bin: 'powershell', args: ['-NoProfile', '-Command', ps] };
  }
  return null;
}

// Escape for osascript `keystroke` string literal: only \ and " need escaping.
function _escapeOsascript(text) {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

// Escape for PowerShell SendKeys: +^%~(){}[] are special.
function _escapeSendKeys(text) {
  return text.replace(/[+^%~(){}[\]]/g, (ch) => `{${ch}}`);
}

module.exports = {
  PLATFORM,
  whisperDir,
  configPath,
  hasBinary,
  recorderConfig,
  sttConfig,
  whisperConfig,
  injectionCmd,
  streamSttScript,
  swiftStreamCmd,
  _escapeOsascript,
  _escapeSendKeys,
  _winRecorderConfig,
};
