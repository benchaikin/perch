#!/usr/bin/env bash
# Regression guard for the land-dex reaper's bash-3.2 compatibility.
#
# macOS ships GNU bash 3.2.57 as /bin/bash (Apple froze bash at 3.2 over GPLv3),
# so reap-dex-worktrees.sh must avoid bash-4-only constructs. #55 reintroduced
# `declare -A`, which aborts under 3.2 with `set -euo pipefail` BEFORE a single
# worktree is processed — auto-land silently became a no-op. This check makes
# such a regression fail loud instead: it greps the skill's shell scripts for
# known bash-4-only constructs and asks bash to parse each one. Run it locally or
# wire it into CI; a non-zero exit means a bash-4-ism (or syntax error) relanded.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
status=0

# bash-4-only constructs that 3.2 cannot parse/run. Each is an ERE matched per
# line; keep the pattern and the human-readable reason in lockstep.
patterns=(
  'declare[[:space:]]+-A|local[[:space:]]+-A|readonly[[:space:]]+-A'
  'declare[[:space:]]+-g'
  '\bmapfile\b|\breadarray\b'
  '\$\{[A-Za-z_][A-Za-z0-9_]*(\[[^]]*\])?\^\^?'
  '\$\{[A-Za-z_][A-Za-z0-9_]*(\[[^]]*\])?,,?'
  '&>>'
)
reasons=(
  'associative array (declare/local/readonly -A) — needs bash 4.0+'
  'declare -g (global from function scope) — needs bash 4.2+'
  'mapfile/readarray — needs bash 4.0+'
  '${var^^}/${var^} case conversion — needs bash 4.0+'
  '${var,,}/${var,} case conversion — needs bash 4.0+'
  '&>> append-redirect-both — needs bash 4.0+'
)

for script in "$here"/*.sh; do
  [ "$script" = "$here/reap-dex-lint.sh" ] && continue
  # Must parse under whatever bash is running this lint (3.2 on macOS).
  if ! bash -n "$script" 2>/dev/null; then
    echo "FAIL  $script — does not parse under bash ${BASH_VERSION}" >&2
    bash -n "$script" || true
    status=1
  fi
  i=0
  while [ "$i" -lt "${#patterns[@]}" ]; do
    # grep -n keeps real line numbers; the second grep drops comment-only lines
    # (the patterns are named in this file's and the reaper's own comments) while
    # leaving inline code intact.
    hits="$(grep -nE "${patterns[$i]}" "$script" | grep -vE '^[0-9]+:[[:space:]]*#' || true)"
    if [ -n "$hits" ]; then
      echo "FAIL  $script — ${reasons[$i]}:" >&2
      printf '%s\n' "$hits" | sed 's/^/        /' >&2
      status=1
    fi
    i=$((i + 1))
  done
done

if [ "$status" -eq 0 ]; then
  echo "ok: land-dex shell scripts are bash-3.2 clean" >&2
fi
exit "$status"
