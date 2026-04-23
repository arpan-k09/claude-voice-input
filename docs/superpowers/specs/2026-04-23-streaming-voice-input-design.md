# Streaming Voice Input — Design

**Date:** 2026-04-23
**Status:** Approved for V1 implementation
**Scope:** macOS only for V1. Linux/Windows keep the existing one-shot flow.

## Goal

Replace the one-shot "record → transcribe → inject" flow with a live streaming experience: as the user speaks, transcribed text appears in the prompt buffer via partial-result updates (earlier guesses replaced by refined ones). Recording continues until the user presses Enter to submit; the prompt contents at submission time are what gets sent.

## Non-Goals

- Hold-Space push-to-talk. Not achievable from a Claude Code plugin — no keyboard-hook API.
- Mid-speech editing. Users speak until done, let partials solidify, then edit. If the user types while the subprocess is actively typing, keystrokes interleave; this is acceptable per user direction.
- Linux/Windows streaming in V1. They fall back to the current code path.

## Architecture

### New files

| File | Purpose |
|------|---------|
| `bin/stream.js` | Node orchestrator. Spawns Swift STT subprocess, reads partial/final lines, maintains `typedText`, computes longest-common-prefix diff, issues backspace+type osascript calls. Writes `~/.claude/claude-voice-input/current.pid`. Cleans up on SIGTERM. |
| `bin/submit-hook.js` | `UserPromptSubmit` hook. Reads PID file, sends SIGTERM, exits ≤100ms. |
| `src/stream-diff.js` | Pure diff logic (longest-common-prefix → {backspaces, insert}). Unit-tested. |

### Changed files

| File | Change |
|------|--------|
| `src/platform.js` | Add `streamSttScript()` that returns the Swift source for streaming STT. Existing `_swiftSTTCmd` (file-based) stays for non-streaming paths. |
| `bin/run.js` | On `darwin`, delegate to `bin/stream.js`. On `linux`/`win32`, keep existing one-shot flow. |
| `hooks/hooks.json` | Register `UserPromptSubmit → bin/submit-hook.js`. |
| `commands/voice-input.md` | Rewrite for new semantics: fire subprocess, don't wait, don't use stdout as message. |
| `.claude-plugin/plugin.json` | Bump version to `1.1.0`. |

## Data flow

```
User types /voice-input, presses Enter
  → slash-command skill fires; Claude spawns bin/run.js in background
  → run.js (on darwin) spawns bin/stream.js
  → stream.js writes PID file, spawns Swift STT subprocess
  → Swift uses AVAudioEngine + SFSpeechAudioBufferRecognitionRequest
     with shouldReportPartialResults=true
  → Swift emits "P <text>" / "F <text>" lines
  → stream.js, on each line:
      diff new text vs. typedText
      → osascript: backspace N, type suffix
      update typedText
  → user sees transcription appear/refine in prompt buffer
  → user stops speaking, edits if needed
  → user presses Enter
  → UserPromptSubmit hook runs → SIGTERM to PID from file
  → stream.js cleans up and exits
  → prompt submits with whatever text is currently in it
```

## Key component contracts

### Swift streaming STT

- Reads mic via `AVAudioEngine`.
- Uses `SFSpeechAudioBufferRecognitionRequest` with `shouldReportPartialResults = true`.
- On each recognition callback:
  - emit `P <bestTranscription.formattedString>\n` for non-final results
  - emit `F <bestTranscription.formattedString>\n` for final (segment boundary)
- Handles `SFSpeechRecognizer.requestAuthorization`. If denied, prints error to stderr and exits non-zero.
- On SIGTERM: stops audio engine, flushes final result if any, exits 0.

### stream.js diff/keystroke logic (`src/stream-diff.js`)

Given `typedText` and `newText`, compute:
- `P` = length of longest common prefix
- `backspaces` = `typedText.length - P`
- `insert` = `newText.slice(P)`

Issue `backspaces` `delete` keystrokes followed by typing `insert`. Update `typedText = newText`.

For final results: append a space when the next partial starts, so sentences are spaced.

### Debouncing

osascript keystroke has ~10-50ms latency per call. Coalesce updates: if a new partial arrives while an osascript call is in-flight, drop the intermediate and queue only the latest. Minimum 150ms between osascript invocations.

### PID file + hook contract

- stream.js on startup: `fs.writeFileSync('~/.claude/claude-voice-input/current.pid', process.pid)`.
- stream.js on SIGTERM / normal exit: delete PID file.
- submit-hook.js: read PID, `process.kill(pid, 'SIGTERM')`, delete PID file, exit. If PID file missing or process dead, exit silently — the hook must never block prompt submission.

## Error handling

| Situation | Behavior |
|-----------|----------|
| SFSpeechRecognizer auth denied | Swift exits non-zero; stream.js prints guidance to stderr, exits. |
| Mic permission denied | AVAudioEngine fails to start; Swift exits non-zero; stream.js same as above. |
| osascript fails | Log to stderr, continue — can't recover mid-speech. |
| User runs /voice-input while one is already running | stream.js on startup checks PID file, sends SIGTERM to existing process, takes over. |
| Hook fires but PID missing | No-op, exit silently. |

## Testing

1. **Unit test** `src/stream-diff.js` — table of (typedText, newText) → (backspaces, insert) fixtures.
2. **Integration test** stream.js with mock STT — a fake subprocess that emits scripted `P`/`F` lines. Stub osascript with a script that appends invocations to a log file. Assert the log matches the expected sequence.
3. **Manual test** — run `/voice-input`, speak, verify text streams into prompt, press Enter, verify submission includes spoken text.

## Rollout

- V1 is Mac-only streaming. Non-macOS platforms keep the existing one-shot path (no behavior change).
- Bump plugin version to `1.1.0`. User runs `/plugin` to update.
- The existing `--test`, `--lang`, and `setup --whisper` flags still work for the one-shot path; on macOS streaming they're ignored (or fall back to one-shot for `--test`).
