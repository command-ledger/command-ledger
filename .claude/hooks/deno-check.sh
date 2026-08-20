#!/usr/bin/env bash
# PostToolUse check (matcher: Edit|Write). After an Edge Function source
# file is edited, run Deno's built-in checker so a syntax/type error is
# caught immediately instead of only being discovered at
# `supabase functions deploy` time — there is no CI in this repo to catch
# it any other way.

input="$(cat)"

file_path="$(printf '%s' "$input" | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*:[[:space:]]*"([^"]*)"/\1/')"

case "$file_path" in
  *supabase/functions/*.ts) ;;
  *) exit 0 ;;
esac

if ! command -v deno >/dev/null 2>&1; then
  echo "NOTE: 'deno' is not installed/on PATH, so $file_path was not type-checked. Install the Deno CLI (https://docs.deno.com/runtime/getting_started/installation/) to enable this check." >&2
  exit 0
fi

if ! deno check "$file_path" 2>&1 >&2; then
  echo "Deno check failed for $file_path — see errors above." >&2
  exit 2
fi

exit 0
