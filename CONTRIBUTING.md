# Contributing

`claude-voice-input` is intentionally small (~400 lines of source). The bar for new
features is: does it extend platform coverage, remove a real source of bugs, or
improve privacy guarantees? Documentation, tests, and recorder/STT/injection
improvements are always welcome.

## Dev setup

```sh
git clone https://github.com/arpan-k09/claude-voice-input.git
cd claude-voice-input
npm test   # runs all three suites in under 2s, zero deps
```

Node 18 or newer. No build steps. No `npm install` needed.

## Code style

- `'use strict'` at the top of every source file.
- Zero runtime `dependencies` in `package.json`. Dev dependencies are strongly
  discouraged; open an issue first if you think you need one.
- No `if (process.platform === '...')` outside `src/platform.js`. All platform
  branching lives there.
- Comments explain *why*, not *what*. If a line needs a comment to say what it
  does, rewrite the line.
- Defensive only at system boundaries (file I/O, subprocess, user-controlled JSON).
  Trust internal callers.

## Running tests in isolation

All test suites use `mkdtemp` for fake home directories and stub `child_process`
for subprocess calls. They never touch your real `~/.claude/settings.json`.

```sh
node test/installer.test.js
node test/transcriber.test.js
node test/platform.test.js
```

To drive the CLI against an isolated home:

```sh
HOME=$(mktemp -d) node bin/claude-voice-input.js install
```

## Pull requests

- Open an issue first for changes > 50 lines or anything touching `src/installer.js`.
- Keep unrelated changes in separate PRs.
- Add or update tests for anything that changes installer, transcriber, or platform
  behavior. Match the existing in-file zero-dep runner style — don't introduce a
  test framework.
- Keep commits focused; the subject line should work as a changelog entry.

## Reporting bugs

Use the templates in `.github/ISSUE_TEMPLATE/`. Bug reports that include the
output of `node bin/claude-voice-input.js` and your platform/Node version are
dramatically easier to action.

## Code of conduct

Be decent. Disagreements are welcome, condescension is not.
