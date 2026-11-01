#!/usr/bin/env bash
# Quick entrypoint for computer installation
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$SCRIPT_DIR/scripts/install-computer.sh" "$@"
