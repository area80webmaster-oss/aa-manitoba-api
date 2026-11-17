#!/usr/bin/env bash
# Switch the public meeting list between the two CMS structures.
#
#   scripts/meetings-switch.sh v2     cut over: /meetings reads Groups + Group Meetings
#   scripts/meetings-switch.sh v1     ROLL BACK: /meetings reads the old flat Meetings
#   scripts/meetings-switch.sh status show what is live and how the two differ
#
# What a switch does: rewrites src/lib/meetings-source.json, runs the tests,
# type check and build, commits that one file to main and pushes (Netlify
# deploys main in about a minute), then waits until api.aamanitoba.org/meetings
# answers from the new source and prints the v1-vs-v2 comparison. The geocoder
# and the legacy watch follow the same file automatically, and the push runs
# them once straight away.
#
# Faster emergency rollback, no git needed: Netlify → aa-manitoba-api →
# Deploys → open the last deploy from before the switch → "Publish deploy".
# Then run `scripts/meetings-switch.sh v1` so main matches what is live.
#
# Rolling back to v1 hides every edit volunteers made in the new collections
# since the cutover; the comparison printed at the end lists them (run with
# COMPARE_VALUES=1 to see the values) so they can be re-entered in the old
# collection. See docs/meetings-cutover-runbook.md.
set -euo pipefail

TARGET="${1:-}"
API="https://api.aamanitoba.org/meetings"
SOURCE_FILE="src/lib/meetings-source.json"
WAIT_SECONDS="${WAIT_SECONDS:-600}"

cd "$(dirname "$0")/.."

compare() {
  if [[ "${COMPARE_VALUES:-0}" == "1" ]]; then
    node scripts/compare-meetings-sources.mjs --values
  else
    node scripts/compare-meetings-sources.mjs
  fi
}

live_source() {
  curl -s -o /dev/null -D - --max-time 20 "$API?cb=$(date +%s)$RANDOM" \
    | tr -d '\r' | awk -F': ' 'tolower($1)=="x-meetings-source"{print $2}'
}

case "$TARGET" in
  v1|v2) ;;
  status)
    echo "meetings-source.json on this checkout: $(node -e 'console.log(JSON.stringify(require("./src/lib/meetings-source.json")))')"
    compare
    exit 0
    ;;
  *)
    echo "usage: $0 v1|v2|status" >&2
    exit 64
    ;;
esac

# Preconditions: on main, in step with origin, the switch file untouched.
git fetch -q origin main
branch="$(git rev-parse --abbrev-ref HEAD)"
[[ "$branch" == "main" ]] || { echo "Refusing: on branch '$branch', not main." >&2; exit 1; }
[[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] || {
  echo "Refusing: local main differs from origin/main (pull or push first)." >&2
  exit 1
}
git diff --quiet -- "$SOURCE_FILE" && git diff --cached --quiet || {
  echo "Refusing: $SOURCE_FILE has local changes, or something is already staged." >&2
  exit 1
}

current="$(node -e 'console.log(require("./src/lib/meetings-source.json").source)')"
if [[ "$current" == "$TARGET" ]]; then
  echo "Already on $TARGET in main; checking what production serves."
else
  echo "Switching /meetings from $current to $TARGET."
  node --input-type=module -e '
    import { writeFileSync } from "node:fs";
    import { parseSource } from "./scripts/lib/meetings-source.mjs";
    const target = process.argv[1];
    const config = { source: target, since: target === "v2" ? new Date().toISOString() : null };
    parseSource(JSON.stringify(config));
    writeFileSync("src/lib/meetings-source.json", JSON.stringify(config, null, "\t") + "\n");
  ' "$TARGET"
  cat "$SOURCE_FILE"

  echo "Running tests, type check and build…"
  if ! { node scripts/test-meetings-source.mjs \
      && node scripts/test-meetings-v2-derive.mjs >/dev/null \
      && node scripts/test-meetings-v2-feed.ts >/dev/null \
      && pnpm -s check >/dev/null \
      && pnpm -s build >/dev/null; }; then
    git checkout -- "$SOURCE_FILE"
    echo "Checks failed; nothing was committed or pushed. $SOURCE_FILE restored." >&2
    exit 1
  fi

  msg="Switch /meetings to $TARGET"
  [[ "$TARGET" == "v1" ]] && msg="Roll /meetings back to v1 (flat Meetings collection)"
  [[ "$TARGET" == "v2" ]] && msg="Switch /meetings to v2 (Groups + Group Meetings)"
  if [[ -n "${MEETINGS_SWITCH_TRAILER:-}" ]]; then
    git commit -q -m "$msg" -m "$MEETINGS_SWITCH_TRAILER" -- "$SOURCE_FILE"
  else
    git commit -q -m "$msg" -- "$SOURCE_FILE"
  fi
  git push -q origin main
  echo "Pushed $(git rev-parse --short HEAD) to main; waiting for Netlify to deploy it."
fi

deadline=$(( $(date +%s) + WAIT_SECONDS ))
while :; do
  got="$(live_source || true)"
  if [[ "$got" == "$TARGET" ]]; then
    echo "Production /meetings answers from $TARGET."
    break
  fi
  if [[ "$TARGET" == "v2" && "$got" == "v1-fallback" ]]; then
    echo "WARNING: the v2 reader failed and /meetings fell back to v1. Investigate, or roll back with: $0 v1" >&2
    break
  fi
  if (( $(date +%s) > deadline )); then
    echo "Timed out after ${WAIT_SECONDS}s; production says '${got:-nothing}'. Check the Netlify deploy log." >&2
    exit 1
  fi
  sleep 15
done

echo
compare
echo
if [[ "$TARGET" == "v1" ]]; then
  echo "ROLLED BACK. Tell the editors to use the old Meetings collection again; the lines marked ~/+/- above"
  echo "are edits made in Groups / Group Meetings that the old collection does not have."
else
  echo "LIVE ON v2. Editors edit Groups + Group Meetings from now on; the old Meetings collection is frozen."
fi
echo "Edge caches can serve the previous answer to some visitors for up to 5 minutes."
