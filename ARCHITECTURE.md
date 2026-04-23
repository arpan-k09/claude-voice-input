# Architecture

`claude-voice-input` captures voice locally, transcribes on-device, and injects the
result as keystrokes into the active terminal. This document explains the engineering
decisions behind the 400-line implementation.

## Module breakdown

```
src/platform.js          ALL platform detection and binary resolution — the only file
                         that knows about darwin / linux / win32
src/recorder.js          async audio capture → temp WAV; silence-stop + 30s hard timeout
src/transcriber.js       STT dispatch: whisper opt-in → platform default → error
src/injector.js          keystroke injection via OS accessibility APIs
src/installer.js         settings.json read / backup / atomic-write / idempotent-merge
bin/run.js               thin orchestrator: record → transcribe → inject → cleanup
bin/claude-voice-input.js user CLI: install / uninstall / status / test / setup / lang
```

Each module has exactly one responsibility. `platform.js` never calls `execFile`;
`recorder.js` never reads config; `installer.js` never touches audio. The constraint
that all platform branching lives in `src/platform.js` is enforced by the test suite's
final check: `grep -r "process\.platform" src bin | grep -v platform.js` must produce
no output.

## Why PTY wrapping was rejected

An earlier design wrapped Claude Code inside a pseudo-terminal, proxied its I/O, and
watched the output stream for "prompt-like" patterns (question marks, y/n prompts,
silence after output). This approach was considered for `claude-voice-input` and
rejected for the same reasons it was rejected in the companion project
`claude-voice-cue`:

| Concern | PTY wrapper | Slash command |
|---------|-------------|---------------|
| Runtime deps | `node-pty` native module, prebuild, permissions | None |
| Detection | Heuristic — false positives and negatives both real | Exact user intent |
| TUI resilience | Any Claude TUI change risks breaking the detector | Command surface is stable |
| Lines of code | ~450 + tests | ~250 + tests |
| Subcommand coverage | Hardcoded to one subcommand | Works everywhere |

The slash command `/voice-input` gives users an explicit, intentional trigger.
There is no "detect when the user wants to speak" problem to solve — the user
tells the tool when they want to speak.

## Why no background daemon

A daemon would idle in memory waiting for a global hotkey. Rejected because:

- Requires OS-specific auto-start infrastructure (launchd plist / systemd unit /
  Windows Task Scheduler). Each is a different maintenance surface.
- Daemons accumulate across reboots and version upgrades without explicit cleanup.
- A long-lived process with microphone access is a standing privacy risk.
- Claude Code's `/voice-input` slash command provides on-demand activation with
  no ambient footprint. The plugin is invoked, runs, and exits.

## Silence detection implementation

SoX's `silence` effect is used when `rec` (SoX) is the recorder:

```
rec output.wav silence 1 0.1 1% 1 2.0 1%
```

Interpretation: begin recording when amplitude exceeds 1% of maximum for 0.1 s;
stop when amplitude falls below 1% for a continuous 2.0 s. This reliably catches
natural pauses between sentences without cutting off mid-word.

The 30-second hard timeout in `recorder.js` fires `SIGTERM` on the child process
as an absolute ceiling. Without it, a misconfigured SoX or a noisy environment
could hang the plugin indefinitely.

The `arecord` fallback (Linux ALSA) does not support the silence effect; it records
for the full 30 seconds. Users who want silence detection on Linux should install
SoX (`sudo apt install sox`), which is detected first by `recorderConfig()`.

## Why text injection via OS accessibility APIs

Three delivery mechanisms were considered:

**Clipboard paste** — write transcript to the clipboard, then simulate Cmd+V or Ctrl+V.
Rejected: clobbers whatever the user previously copied; pasting into a TUI prompt
behaves inconsistently across terminal emulators.

**stdout → command handler** — `bin/run.js` prints the transcript to stdout and
`commands/voice-input.md` tells Claude to treat it as the next user message. Cleaner
in principle, but it routes through Claude's command runner rather than landing
directly in the terminal's input buffer, and it requires Claude to "cooperate" for
the injection to occur.

**Keystroke injection** (chosen) — `osascript keystroke` (macOS), `xdotool type`
(Linux), PowerShell `SendKeys` (Windows). Simulates the user typing directly into the
focused window. Keystrokes land in exactly the same input path as manual typing.
The tradeoff is a dependency on the injection binary being present (xdotool on Linux)
and the terminal window having OS focus at injection time — both conditions that hold
in normal `/voice-input` use.

Special-character escaping is handled exclusively in `platform.injectionCmd()`.
Callers pass raw strings; the platform module applies the correct escaping for each
method (`\"` for osascript, `{+}` for SendKeys).

## Whisper opt-in: why it is never bundled or auto-downloaded

- The `ggml-tiny.en` model is 39 MB. Bundling it in the repo violates the
  lightweight plugin philosophy and would make `git clone` unusably slow.
- Auto-downloading binaries at install time is a supply chain risk. The user must
  consciously type `claude-voice-input setup --whisper` to initiate any network
  activity.
- Most users have access to a zero-install platform STT: macOS has
  SFSpeechRecognizer, Windows has SAPI, and Linux users with `vosk-transcriber`
  installed get that for free.
- The `setup --whisper` command is the **only** place in the entire codebase that
  makes a network call. Everything else — install, uninstall, record, transcribe,
  inject — runs fully offline.

## Atomic write pattern for settings.json

`src/installer.js` writes `~/.claude/settings.json` through:

1. Compute new content in memory.
2. Write to `settings.json.tmp.<pid>.<timestamp>`.
3. `fs.renameSync(tmp, settings.json)`.

`rename(2)` is atomic on POSIX. On NTFS the guarantee is weaker but still
sufficient for single-process use. If the process is killed between steps 2 and 3,
the real settings file is untouched; the `.tmp` file is harmless garbage. Without
atomicity, a crash mid-write leaves Claude Code with a truncated or half-overwritten
settings file — a silent catastrophic failure.

Complementary rules in `installer.js`:
- Read and parse before any write; refuse if the JSON is invalid.
- Copy to a timestamped `.bak` file before any mutation.
- Touch only entries whose command string includes `claude-voice-input`; leave
  all other hooks byte-identical.
- Re-running install when the current command is already registered is a zero-write
  no-op: no backup, no rename, no disk I/O.

## Known limitations and future work

**xdotool dependency on Linux.** Text injection requires `xdotool`. On Wayland,
`xdotool` may not work at all; `ydotool` is the Wayland-native alternative. The
injector returns a clear error with install instructions when xdotool is absent.

**macOS SFSpeechRecognizer requires Swift toolchain.** The zero-install macOS STT
backend compiles a small Swift file at runtime with `swift <file.swift>`. This
requires Xcode Command Line Tools (`xcode-select --install`). Users without Swift
should run `setup --whisper` for a self-contained binary path.

**arecord has no silence detection.** Linux ALSA recordings run for the full 30-second
hard timeout unless SoX is also installed. Install SoX to enable silence-triggered
stop on Linux.

**Windows recording via PowerShell SAPI is combined record+transcribe.** When
ffmpeg is absent on Windows, the recorder uses SAPI's
`SpeechRecognitionEngine.Recognize()` which does recognition in-process and writes
the transcript as a text file. The transcriber detects the `.txt` extension and
returns its content directly, skipping the normal STT dispatch. This is an honest
limitation: a separate WAV recorder for Windows without ffmpeg would require a
native module or a bundled binary, both of which violate the zero-dependency
constraint.

**Focus requirement for injection.** Keystroke injection requires the terminal
running Claude Code to have OS focus at the moment of injection. If the user
switches windows during recording, keystrokes may land in the wrong application.
