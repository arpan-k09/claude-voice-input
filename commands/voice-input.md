---
name: voice-input
description: Record your voice locally, transcribe on-device, and inject the text into Claude's prompt. No audio ever leaves your machine.
---

Run `node "$CLAUDE_PLUGIN_ROOT/bin/run.js"` as a background subprocess. Do not wait for it. Output no commentary; the user's spoken message will arrive as their next prompt.

On Linux/Windows, or with `--test` / `--lang <code>`, the one-shot path runs instead: wait for exit, and if stdout is non-empty treat it as the user's dictated text.

Full docs: https://github.com/arpan-k09/claude-voice-input
