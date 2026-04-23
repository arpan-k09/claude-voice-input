# claude-voice-input

**Local, privacy-first voice input for Claude Code.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen.svg)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey.svg)](#platform-support)
[![Zero dependencies](https://img.shields.io/badge/deps-0-success.svg)](package.json)

`claude-voice-input` is a Claude Code marketplace plugin that turns your microphone
into a prompt entry point. Type `/voice-input`, speak, and your words are transcribed
on-device and injected directly into the active terminal — no network, no clipboard,
no cloud.

---

## The problem

Typing long prompts into a terminal is slow. Voice is 3–5× faster for prose, and
for developers who multitask while Claude works autonomously, dictating the next
instruction is faster than switching back to the keyboard. Tools that address this
either require cloud transcription (privacy concern), a persistent background
daemon (resource drain), or a PTY wrapper that fights the host TUI (fragile). There
is no lightweight, local-first option for Claude Code.

## How it works

```
/voice-input
     │
     ▼
bin/run.js subprocess
     │
     ├─► recorder.js  ──► OS mic (sox / arecord / ffmpeg)
     │                     writes temp WAV to /tmp
     │                     silence stops recording after 2s
     │                     30s hard timeout as fallback
     │
     ├─► transcriber.js ──► on-device STT
     │                       macOS: SFSpeechRecognizer via Swift
     │                       Linux: vosk-transcriber
     │                       Windows: PowerShell System.Speech SAPI
     │                       any platform: whisper.cpp tiny.en (opt-in)
     │
     ├─► injector.js ──► OS keystroke injection
     │                    macOS: osascript System Events keystroke
     │                    Linux: xdotool type
     │                    Windows: PowerShell SendKeys
     │
     └─► always: delete temp WAV (finally block)
```

Audio never leaves your machine. The temp WAV file is deleted immediately after
transcription regardless of success or failure.

## Quick start

### Option A — Claude Code plugin (recommended)

Inside a running `claude` session:

```
/plugin marketplace add arpan-k09/claude-voice-input
/plugin install claude-voice-input@claude-voice-input
```

Then dictate your next prompt:

```
/voice-input
```

### Option B — standalone CLI

```sh
git clone https://github.com/arpan-k09/claude-voice-input.git
cd claude-voice-input
node bin/claude-voice-input.js install
```

Verify everything works:

```sh
node bin/claude-voice-input.js test   # 3-second test recording, prints transcript
node bin/claude-voice-input.js        # show install status and detected backends
```

## Platform support

| Platform | Recorder | STT (default) | STT (opt-in) | Injection |
|----------|----------|--------------|--------------|-----------|
| **macOS** | `rec` (sox) or `ffmpeg` | SFSpeechRecognizer via Swift | whisper.cpp tiny.en | `osascript keystroke` |
| **Linux** | `arecord` or `rec` or `ffmpeg` | `vosk-transcriber` if installed | whisper.cpp tiny.en | `xdotool type` |
| **Windows** | `ffmpeg` or PowerShell SAPI | PowerShell SAPI (combined) | whisper.cpp tiny.en | PowerShell SendKeys |

**Install prerequisites:**
- macOS recorder: `brew install sox` (recommended for silence detection)
- macOS STT: Xcode CLT — `xcode-select --install`
- Linux recorder: `sudo apt install sox` or `arecord` (already in `alsa-utils`)
- Linux injection: `sudo apt install xdotool`
- Whisper opt-in (any platform): `claude-voice-input setup --whisper`

## Privacy

| Data | Stays local? |
|------|-------------|
| Audio recording | Always — temp WAV in `/tmp`, deleted immediately after transcription |
| Transcript text | Always — typed as keystrokes into the local terminal |
| STT processing | Always — on-device only (SFSpeechRecognizer / SAPI / vosk / whisper.cpp) |
| Network calls | Only during `setup --whisper` (one-time model download, explicit opt-in) |

No analytics. No telemetry. No cloud STT. The `setup --whisper` command is the
only place in the codebase that accesses the network.

## CLI reference

```
claude-voice-input                    show install status, platform, STT backend
claude-voice-input install            register plugin marker in ~/.claude/settings.json
claude-voice-input uninstall          remove our entries (leave everything else intact)
claude-voice-input test               test recording — transcribes and prints, no injection
claude-voice-input setup --whisper    download whisper.cpp tiny.en model (opt-in, ~39MB)
claude-voice-input --lang <code>      set dictation language (e.g. en-US, fr-FR)
claude-voice-input --help             usage
```

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design rationale, including:
why PTY wrapping was rejected, why there is no daemon, how silence detection works,
why keystroke injection was chosen over clipboard paste, the whisper opt-in decision,
and the atomic write pattern for settings.json.

## Relationship to claude-voice-cue

[`claude-voice-cue`](https://github.com/arpan-k09/claude-voice-cue) and
`claude-voice-input` are complementary and independent:

| Plugin | Direction | What it does |
|--------|-----------|--------------|
| `claude-voice-cue` | **output** | Speaks a phrase when Claude needs your attention |
| `claude-voice-input` | **input** | Lets you speak your prompt instead of typing it |

Together they form a complete local voice layer around Claude Code, but neither
depends on the other. Install one, both, or neither.

## Running the tests

```sh
npm test
```

The full suite runs in under 2 seconds, has zero external dependencies, and exercises
all installer lifecycle branches, STT backend selection, whisper opt-in, timeout
handling, and platform escape logic.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © Arpan Korat
