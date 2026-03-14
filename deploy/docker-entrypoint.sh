#!/bin/sh
# Docker entrypoint for CoWork OS.
# Sets TZ from COWORK_TZ when provided (IANA timezone, e.g. America/New_York).
if [ -n "$COWORK_TZ" ]; then
  # Basic validation: invalid TZ can cause silent date bugs. Fall back to UTC if invalid.
  if (TZ="$COWORK_TZ" date +%Z >/dev/null 2>&1); then
    export TZ="$COWORK_TZ"
  else
    echo "[cowork-entrypoint] Invalid COWORK_TZ='$COWORK_TZ', using UTC" >&2
    export TZ="UTC"
  fi
fi
exec "$@"
