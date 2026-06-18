#!/bin/sh
# Example launchd wrapper. Copy outside the repo, edit absolute paths, and chmod 700.
set -eu
ENV_FILE="${SKC_TELEGRAM_REMOTE_ENV_FILE:-$HOME/Library/Application Support/skc/telegram-remote.env}"
CHECKOUT="${SKC_TELEGRAM_REMOTE_CHECKOUT:-$HOME/src/sayknow-cli}"
BUN="${SKC_BUN:-$HOME/.bun/bin/bun}"

if [ ! -f "$ENV_FILE" ]; then
  echo "Telegram Remote env file is missing" >&2
  exit 1
fi
perm=$(stat -f "%Lp" "$ENV_FILE" 2>/dev/null || echo "")
if [ "$perm" != "600" ]; then
  echo "Telegram Remote env file must be mode 600" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
cd "$CHECKOUT/packages/telegram-remote"
exec "$BUN" run src/cli.ts
