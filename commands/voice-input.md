---
name: voice-input
description: Record your voice locally, transcribe on-device, and inject the text into Claude's prompt. No audio ever leaves your machine.
---

When the user types `/voice-input`, execute the following:

## Voice Input Flow (macOS — streaming)

1. Spawn `node "$CLAUDE_PLUGIN_ROOT/bin/run.js"` in the background. Do **not** wait for it to exit.
2. The subprocess types transcribed text into the focused prompt buffer via `osascript` as the user speaks, using `SFSpeechRecognizer` with `shouldReportPartialResults = true`. Earlier guesses are replaced by refined ones (backspace + retype).
3. When the user presses Enter, the plugin's `UserPromptSubmit` hook sends `SIGTERM` to the subprocess, which stops recording and exits. Claude Code submits whatever text is currently in the prompt — that's the dictated message.
4. Because the text lives in the prompt buffer, the user can also edit it before pressing Enter.

**Do not use the subprocess's stdout as the user's next message on macOS.** The message is the prompt buffer contents at Enter time.

## Voice Input Flow (Linux / Windows — one-shot)

1. Run `node "$CLAUDE_PLUGIN_ROOT/bin/run.js"` and wait for it to complete.
2. The subprocess records, transcribes, and injects the final transcript via OS accessibility APIs.
3. Status messages go to stderr (`Recording...` / `Transcribing...` / `Injecting:`).
4. Exits 0 on success, 1 on error.

## Flags

- `--test`: Record and transcribe without injecting. Prints transcript to stdout. Uses the one-shot code path on every platform. Use to verify your setup:
  ```
  /voice-input --test
  ```
- `--lang <code>`: Override language for this session (e.g. `--lang fr-FR`). On macOS streaming, sets the `SFSpeechRecognizer` locale. To persist the setting:
  ```
  claude-voice-input --lang fr-FR
  ```

## STT Backends

| Platform | Backend | How to enable |
|----------|---------|--------------|
| macOS | `SFSpeechRecognizer` streaming | Default. Grant access in System Settings → Privacy & Security → Speech Recognition. |
| Linux | whisper.cpp tiny.en | `claude-voice-input setup --whisper` (opt-in, one-time ~39MB download) |
| Linux | vosk-transcriber | `pip install vosk` then download a Vosk model |
| Windows | SAPI | Default, via PowerShell System.Speech |

## Troubleshooting

**Microphone permission denied (macOS)**
> Fix: System Settings → Privacy & Security → Microphone → enable your terminal app.

**Speech recognition not authorized (macOS)**
> Symptom: `Speech recognition not authorized` in stderr.
> Fix: System Settings → Privacy & Security → Speech Recognition → enable your terminal app.

**No STT backend found (Linux)**
> Fix: Run `claude-voice-input setup --whisper` to download the whisper.cpp tiny.en model.
> Or: `pip install vosk` and download a Vosk model for your language.

**Text injection failed — xdotool not installed (Linux)**
> Fix: `sudo apt install xdotool` (Debian/Ubuntu) or `sudo dnf install xdotool` (Fedora).
