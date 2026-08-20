#!/usr/bin/env bash
# PreToolUse guard (matcher: Bash). Blocks `git commit` if the staged diff
# contains what looks like a hardcoded secret.
#
# This exists because checkout.html shipped with a hardcoded Paystack test
# key and a corrupted PayPal client ID that sat in the repo, reachable in
# production, until a manual audit caught them. This is a cheap, automatic
# backstop against that failure mode repeating.

input="$(cat)"

# Stay a no-op for every Bash call that isn't a commit — this fires on
# every Bash invocation, so the common path must be fast and silent.
case "$input" in
  *"git commit"*) ;;
  *) exit 0 ;;
esac

staged="$(git diff --cached -- . ':(exclude)package-lock.json' 2>/dev/null || true)"
[ -z "$staged" ] && exit 0

pattern='sk-[A-Za-z0-9]{20,}|pk_(test|live)_[A-Za-z0-9]{10,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|eyJhbGciOi[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|client[_-]?secret["'"'"':= ]+[A-Za-z0-9_-]{16,}'

if echo "$staged" | grep -E -q "$pattern"; then
  echo "BLOCKED: staged changes contain what looks like a hardcoded secret (API key, private key, or token pattern). Move it to an env var or a Supabase Edge Function secret instead of committing it." >&2
  exit 2
fi

exit 0
