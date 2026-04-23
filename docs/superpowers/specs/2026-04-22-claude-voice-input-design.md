# claude-voice-input — Design Document

**Date:** 2026-04-22  
**Author:** Arpan Korat  
**Status:** Approved

---

## Problem

Claude Code users want to speak their prompts rather than type them — especially for longer, exploratory instructions where voice is faster. No existing solution is privacy-first, zero-install, and integrated directly into the Claude Code prompt flow.

## Goal

A Claude Code marketplace plugin called `claude-voice-input` that:
- Registers a `/voice-input` slash command
- Records audio locally when invoked
- Transcribes it using the best available local STT backend
- Delivers the transcript as the user's next prompt to Claude
- Never sends audio to any network endpoint
- Runs on macOS, Linux, and Windows with no runtime npm dependencies

---

## Architecture

### Module boundaries

```
src/platform.js     ALL platform detection and binary resolution (single dispatch point)
src/recorder.js     cross-platform audio capture → temp file
src/transcriber.js  STT dispatch: OS-native → Whisper fallback chain
src/injector.js     delivers transcript to Claude (stdout write)
src/installer.js    settings.json merge, backup, atomic write
bin/run.js          thin entry point: orchestrates record → transcribe → inject
bin/claude-voice-input.js  CLI: install / uninstall / test / status / setup
```

Each module has exactly one responsibility and no inline platform checks.

### Invocation flow (plugin mode)

```
User types /voice-input
        │
        ▼
commands/voice-input.md  (skill loaded by Claude Code AI)
        │  instructs Claude to run bin/run.js via Bash
        ▼
bin/run.js
   ├─ src/recorder.js   ──► os.tmpdir()/vi-<pid>.wav
   ├─ src/transcriber.js ──► transcript string
   └─ src/injector.js   ──► stdout: "transcript text here"
        │
        ▼
Claude Code AI receives stdout as user's spoken prompt
```

### Text delivery decision

`src/injector.js` writes the transcript to **stdout**. `commands/voice-input.md` instructs Claude to treat that output as the user's next instruction. This is:
- Reliable: no OS accessibility permissions, no timing dependencies
- Universal: works identically on macOS, Linux, Windows
- Correct: matches how Claude Code's command/skill system is designed to work

Keystroke injection (AppleScript, xdotool, SendKeys) was considered and rejected: when `run.js` is a Claude Code command subprocess, the TUI is not in an idle-input state, making keystroke injection timing-dependent and fragile.

---

## Platform matrix

### Audio recording

| Platform | Primary | Fallback |
|----------|---------|---------|
| macOS | `sox rec` with silence detection | `afrecord` (CoreAudio) |
| Linux | `arecord` (ALSA) | `sox rec` |
| Windows | PowerShell `System.Speech` capture | `sox rec` |

Silence detection: 2s of silence below -50dB stops recording. Hard timeout: 30s.
Temp file: `os.tmpdir()/vi-<pid>-<ts>.wav`, deleted in `finally`.

### STT backends

| Platform | Default (zero install) | Opt-in |
|----------|----------------------|--------|
| macOS | `osascript` Speech framework | `whisper.cpp` tiny.en |
| Linux | `vosk-transcriber` if installed | `whisper.cpp` tiny.en |
| Windows | PowerShell `SpeechRecognitionEngine` | `whisper.cpp` tiny.en |

Whisper is never bundled. `claude-voice-input setup --whisper` is the only command that touches the network.

---

## Installer

Ports the `claude-voice-cue` installer pattern exactly:
- Marker: `"claude-voice-input"` substring in hook command string
- `readSettings` → defensive parse → throw on malformed JSON
- `backup(file)` → timestamped copy before any mutation
- `atomicWrite(file, content)` → write to `.tmp.<pid>.<ts>`, then `renameSync`
- `upsertEventEntry` → replace-in-place or append, never duplicate
- Hook event: `Stop` with empty matcher, command: `node "<abs-path>/bin/run.js" --on-stop`
- `--on-stop` mode exits 0 immediately (pure marker; actual voice capture is user-triggered via `/voice-input`)
- Also copies `commands/voice-input.md` → `~/.claude/commands/voice-input.md` so `/voice-input` is available in all Claude sessions without the plugin marketplace

---

## CLI

```
claude-voice-input                  status
claude-voice-input install          register plugin
claude-voice-input uninstall        remove only our entries
claude-voice-input test             3s test recording + print transcript
claude-voice-input setup --whisper  download whisper.cpp (network, opt-in)
claude-voice-input --lang <code>    set language (persisted to config.json)
claude-voice-input --help           usage
```

---

## Tests

`node:test` runner (built-in), zero deps, <2s total.

- `test/installer.test.js`: 8 lifecycle branches (fresh install, idempotent, malformed JSON, uninstall, never-installed no-op, unrelated hooks preserved, backup created, atomic write verified)
- `test/transcriber.test.js`: backend selection per platform, Whisper flag, fallback chain, timeout enforcement
- `test/platform.test.js`: binary resolution paths, null-not-throw on missing binary, special char escaping

---

## Constraints met

1. Zero runtime npm dependencies
2. No background daemon
3. No PTY wrapping
4. Non-blocking (async with AbortController timeouts)
5. Single responsibility
6. ~300–400 LOC target
7. Cross-platform via `src/platform.js` only
8. Safe installer (atomic, backup, idempotent, malformed-JSON-safe)
9. Privacy by default (temp file deleted in finally, no network audio)
10. Tests <2s, zero deps, all installer branches covered
