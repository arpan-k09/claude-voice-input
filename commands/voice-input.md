---
name: voice-input
description: Record your voice locally, transcribe on-device, and inject the text into Claude's prompt. No audio ever leaves your machine.
---

When the user types `/voice-input`, execute the following:

## Voice Input Flow

1. Run `node "$CLAUDE_PLUGIN_ROOT/bin/run.js"` as a subprocess.
   - The subprocess records the user's microphone, transcribes locally, and injects the transcript into the active terminal via OS accessibility APIs.
   - Status messages are written to stderr (Recording... / Transcribing... / Injecting:).
   - Exits 0 on success, 1 on error.

2. Wait for the subprocess to complete.

3. If the subprocess exits 0 and produced output on stdout, treat that output as the user's dictated text and use it as the next user message.

4. If the subprocess exits non-zero, report the error message from stderr to the user.

## Flags

- `--test`: Record and transcribe without injecting. Prints transcript to stdout. Use to verify your setup:
  ```
  /voice-input --test
  ```
- `--lang <code>`: Override language for this session (e.g. `--lang fr-FR`). To persist the setting:
  ```
  claude-voice-input --lang fr-FR
  ```

## STT Backends (in priority order)

| Backend | How to enable |
|---------|--------------|
| whisper.cpp tiny.en | `claude-voice-input setup --whisper` (opt-in, one-time ~39MB download) |
| macOS SFSpeechRecognizer | Default on macOS; requires Xcode CLT (`xcode-select --install`) |
| vosk-transcriber | Linux; `pip install vosk` then download a Vosk model |
| Windows SAPI | Default on Windows via PowerShell System.Speech |

## Troubleshooting

**Microphone permission denied (macOS)**
> Symptom: empty transcript or osascript error.
> Fix: System Settings → Privacy & Security → Microphone → enable your terminal app.

**No STT backend found**
> Symptom: `No STT backend found.`
> Fix: Run `claude-voice-input setup --whisper` to download the whisper.cpp tiny.en model.
> Linux alternative: `pip install vosk` and download a Vosk model for your language.

**Text injection failed — xdotool not installed (Linux)**
> Symptom: `Injection (xdotool) failed`
> Fix: `sudo apt install xdotool` (Debian/Ubuntu) or `sudo dnf install xdotool` (Fedora).
