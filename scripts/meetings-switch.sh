#!/usr/bin/env bash
# Switch the public meeting list between the two CMS structures.
#
#   scripts/meetings-switch.sh v2     cut over: /meetings reads Groups + Group Meetings
#   scripts/meetings-switch.sh v1     ROLL BACK: /meetings reads the old flat Meetings
#   scripts/meetings-switch.sh status show what is live and how the two differ
#
# What a switch does: rewrites src/lib/meetings-source.json, runs the checks,
# commits that one file to main and pushes (Netlify deploys main in about a
# minute), waits until api.aamanitoba.org/meetings answers from the target and
# prints the v1-vs-v2 comparison. The geocoder, the legacy watch and the
# health check follow the same file, and the push runs them once right away.
#
# Cutting over (v2) refuses unless drafts are hidden (INCLUDE_DRAFTS = false)
# and production's two readers answer as themselves and match exactly.
# ALLOW_DRIFT=1 skips the match for a switch forward after a rollback, when
# drift is expected: first re-enter in v2 any v1 edits made during the
# rollback. `since` is the freeze time of this v2 period (SINCE=<ISO> sets it,
# default now; the legacy watch flags v1 edits after it); `cutoverAt` records
# the first cutover and never changes (it retires the v1→v2 sync for good).
# Roll back only with this script: a `git revert` of a switch commit would
# clear cutoverAt.
#
# Rolling back (v1) only runs the build (SKIP_CHECKS=1 skips that too), so a
# broken test can never block an emergency. It hides every edit volunteers
# made in the new collections since the cutover; the comparison printed at the
# end lists them (COMPARE_VALUES=1 shows the values). Policy: fix forward by
# default; roll back only when the feed itself is broken.
#
# Faster emergency rollback, no git: Netlify → aa-manitoba-api → Deploys →
# a deploy made AFTER the switch was installed but before the v2 switch →
# "Publish deploy". That LOCKS auto-publishing: run this script with v1, then
# "Unlock" (Deploys → "Enable auto publishing"), or later fixes never go live.
# See docs/meetings-cutover-runbook.md.
set -euo pipefail

TARGET="${1:-}"
API="https://api.aamanitoba.org/meetings"
SOURCE_FILE="src/lib/meetings-source.json"
WAIT_SECONDS="${WAIT_SECONDS:-600}"

cd "$(dirname "$0")/.."

compare() {
  local extra=()
  [[ "${COMPARE_VALUES:-0}" == "1" ]] && extra+=(--values)
  # ${a[@]+…} keeps macOS bash 3.2 from calling an empty array unbound under set -u.
  node scripts/compare-meetings-sources.mjs ${extra[@]+"${extra[@]}"} "$@"
}

live_source() {
  curl -s -o /dev/null -D - --max-time 20 "$API?cb=$(date +%s)$RANDOM" \
    | tr -d '\r' | awk -F': ' 'tolower($1)=="x-meetings-source"{print $2}'
}

case "$TARGET" in
  v1|v2) ;;
  status)
    echo "meetings-source.json on this checkout: $(node -e 'console.log(JSON.stringify(require("./src/lib/meetings-source.json")))')"
    compare || true
    exit 0
    ;;
  *)
    echo "usage: $0 v1|v2|status" >&2
    exit 64
    ;;
esac

# Preconditions: on main, in step with origin, nothing uncommitted that the
# checks would test but the commit would not ship.
git fetch -q origin main
branch="$(git rev-parse --abbrev-ref HEAD)"
[[ "$branch" == "main" ]] || { echo "Refusing: on branch '$branch', not main." >&2; exit 1; }
[[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] || {
  echo "Refusing: local main differs from origin/main (pull or push first)." >&2
  exit 1
}
if [[ -n "$(git status --porcelain -- src scripts .github)" ]] || ! git diff --cached --quiet; then
  echo "Refusing: uncommitted or untracked files under src/, scripts/ or .github/, or something staged." >&2
  exit 1
fi

current="$(node -e 'console.log(require("./src/lib/meetings-source.json").source)')"
cutover_now="$(node -e 'console.log(require("./src/lib/meetings-source.json").cutoverAt ?? "")')"

# The geocoder sweep runs at :37 and reads the switch when it starts; a switch
# landing mid-run would let it write the old collection after the freeze.
outside_geocoder_window() {
  local minute=$((10#$(date -u +%M)))
  (( minute < 33 || minute > 50 )) || [[ "${FORCE_WINDOW:-0}" == "1" ]]
}

if [[ "$TARGET" == "v2" && "$current" != "v2" ]]; then
  grep -Eq '^export const INCLUDE_DRAFTS = false;' src/lib/meetings-v2/config.ts || {
    echo "Refusing: INCLUDE_DRAFTS is not false in src/lib/meetings-v2/config.ts, so unfinished drafts would go public." >&2
    exit 1
  }
  outside_geocoder_window || {
    echo "Refusing: the hourly geocoder runs around :37. Retry after :50 (or FORCE_WINDOW=1)." >&2
    exit 1
  }
  if [[ "${ALLOW_DRIFT:-0}" != "1" ]]; then
    echo "Preflight: production ?source=v1 and ?source=v2 must match exactly…"
    compare --require-identical || { echo "Refusing: not identical (see above). Nothing was changed." >&2; exit 1; }
  fi
fi

if [[ "$current" == "$TARGET" ]]; then
  echo "Already on $TARGET in main; checking what production serves."
else
  echo "Switching /meetings from $current to $TARGET."
  SINCE_IN="${SINCE:-}" node --input-type=module -e '
    import { writeFileSync } from "node:fs";
    import { parseSource } from "./scripts/lib/meetings-source.mjs";
    const [target, keptCutover] = process.argv.slice(1);
    let since = null;
    if (target === "v2") {
      const raw = process.env.SINCE_IN;
      // Explicit Z or offset only: a bare local time reads differently here and in CI.
      if (raw && !/(Z|[+-]\d\d:?\d\d)$/.test(raw)) throw new Error("SINCE needs a Z or offset, e.g. 2026-11-17T11:00:00Z");
      const t = raw ? new Date(raw) : new Date();
      if (Number.isNaN(t.getTime()) || t.getTime() > Date.now() + 60000) throw new Error("SINCE must be a valid time, not in the future");
      since = t.toISOString();
    }
    const config = { source: target, since, cutoverAt: keptCutover || since };
    parseSource(JSON.stringify(config));
    writeFileSync("src/lib/meetings-source.json", JSON.stringify(config, null, "\t") + "\n");
  ' "$TARGET" "$cutover_now"
  cat "$SOURCE_FILE"

  restore() { git checkout -- "$SOURCE_FILE"; }
  if [[ "$TARGET" == "v2" ]]; then
    echo "Running tests, type check and build…"
    checks() {
      node scripts/test-meetings-source.mjs \
        && node scripts/test-meetings-v2-derive.mjs >/dev/null \
        && node scripts/test-meetings-v2-feed.ts >/dev/null \
        && pnpm -s check >/dev/null \
        && pnpm -s build >/dev/null
    }
  elif [[ "${SKIP_CHECKS:-0}" == "1" ]]; then
    echo "SKIP_CHECKS=1: committing the rollback without a local build."
    checks() { node scripts/test-meetings-source.mjs; }
  else
    echo "Running the build only (rollback)…"
    checks() { node scripts/test-meetings-source.mjs && pnpm -s build >/dev/null; }
  fi
  if ! checks; then
    restore
    echo "Checks failed; nothing was committed or pushed. $SOURCE_FILE restored." >&2
    exit 1
  fi

  if [[ "$TARGET" == "v2" ]] && ! outside_geocoder_window; then
    restore
    echo "Refusing: the checks ran into the geocoder window around :37. Retry after :50." >&2
    exit 1
  fi
  msg="Switch /meetings to v2 (Groups + Group Meetings)"
  [[ "$TARGET" == "v1" ]] && msg="Roll /meetings back to v1 (flat Meetings collection)"
  if [[ -n "${MEETINGS_SWITCH_TRAILER:-}" ]]; then
    git commit -q -m "$msg" -m "$MEETINGS_SWITCH_TRAILER" -- "$SOURCE_FILE"
  else
    git commit -q -m "$msg" -- "$SOURCE_FILE"
  fi
  if ! git push -q origin main; then
    # A push can fail after it landed; never undo a commit production has.
    git fetch -q origin main || true
    if [[ "$(git rev-parse origin/main)" == "$(git rev-parse HEAD)" ]]; then
      echo "Push reported an error but origin/main has the commit; carrying on."
    else
      git reset -q HEAD~1
      git checkout -- "$SOURCE_FILE"
      echo "Push failed; the commit was undone and $SOURCE_FILE restored. Nothing changed in production." >&2
      exit 1
    fi
  fi
  echo "Pushed $(git rev-parse --short HEAD) to main; waiting for Netlify to deploy it."
fi

status=0
deadline=$(( $(date +%s) + WAIT_SECONDS ))
while :; do
  got="$(live_source || true)"
  if [[ "$got" == "$TARGET" ]]; then
    echo "Production /meetings answers from $TARGET."
    break
  fi
  if [[ "$TARGET" == "v2" && "$got" == "v1-fallback" ]]; then
    echo "FAILED: the v2 reader is failing and /meetings fell back to the frozen v1 list. Roll back with: $0 v1" >&2
    status=3
    break
  fi
  if (( $(date +%s) > deadline )); then
    echo "Timed out after ${WAIT_SECONDS}s; production says '${got:-nothing}'. Check the Netlify deploy log." >&2
    exit 1
  fi
  sleep 15
done

echo
compare_ok=1
compare || compare_ok=0
echo
if [[ "$TARGET" == "v1" ]]; then
  echo "ROLLED BACK. Tell the editors to use the old Meetings collection again."
  if (( compare_ok )); then
    echo "Lines marked ~/+/- above are edits made in Groups / Group Meetings that the old collection does not have."
  fi
  echo "If ?source=v2 did not answer as itself above, that list is INCOMPLETE: take the lost edits from"
  echo "Webflow (Group Meetings / Groups sorted by last updated, since $(node -e 'const c=require("./src/lib/meetings-source.json");console.log(c.cutoverAt ?? "the cutover")'))."
elif (( status == 0 )); then
  echo "LIVE ON v2. Editors edit Groups + Group Meetings from now on; the old Meetings collection is frozen."
fi
(( compare_ok )) || echo "The comparison could not run (a reader failed); check https://api.aamanitoba.org/meetings by hand." >&2
echo "Edge caches can serve the previous answer to some visitors for up to 5 minutes."
exit "$status"
