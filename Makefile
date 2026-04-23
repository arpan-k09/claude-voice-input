# claude-voice-input — convenience wrapper over the Node CLI.
# All targets are thin shims; the CLI is the source of truth.

NODE         ?= node
CLI          := $(NODE) bin/claude-voice-input.js

.PHONY: help install uninstall status test check

help: ## Show this help
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Register the plugin marker in ~/.claude/settings.json (idempotent)
	@$(CLI) install

uninstall: ## Remove our entry, leave everything else intact
	@$(CLI) uninstall

status: ## Show install status, platform, and active STT backend
	@$(CLI)

test: ## Run the full test suite
	@npm test

check: test ## Alias for test
