# Meetings cutover runbook: v1 (flat Meetings) → v2 (Groups + Group Meetings)

`https://api.aamanitoba.org/meetings` is the only data source for the finder on
aamanitoba.org/meetings (TSML UI) and for the Meeting Guide app. Its URL and
JSON shape never change; only the CMS structure behind it does.

## The switch

`src/lib/meetings-source.json` decides which structure is live:

| `source` | `/meetings` reads | geocoder writes pins to | v1→v2 sync |
|---|---|---|---|
| `v1` | Meetings (flat) | Meetings | manual only, and only before the first cutover |
| `v2` | Groups + Group Meetings | Groups | refuses to run |

`since` is the freeze time of the first cutover and never moves: every later
switch keeps it. Once it is set, the v1→v2 sync refuses to run, rollback
included (after a rollback, re-enter v2 edits in v1 by hand, never with the
sync). The dormant instant-geocode webhook also ignores the frozen collection.

Hourly read-only checks run after the geocoder (`.github/workflows/geocode-meetings.yml`,
public logs, slugs only); a failure emails the repo:
- **legacy watch** (`scripts/check-legacy-untouched.mjs`): someone edited the
  old Meetings collection after `since`. Re-enter the edit in the new
  collections; to clear the alert, move `since` past it in a reviewed commit.
- **health check** (`scripts/check-meetings-health.mjs`): `/meetings` answers
  from the wrong reader, a stale copy or the v1 fallback; fewer than 350
  meetings; or a Group Meeting that should be public is missing or skipped.
  It also warns about drafts created since the cutover and about draft/hidden
  groups that still hold public meetings.

Every response carries `X-Meetings-Source: v1 | v2 | v1-fallback`, and
`/meetings?source=v1` or `?source=v2` forces one reader for checking.

Safety nets in the v2 reader: a build that throws, or returns fewer than 300
meetings, serves the last good v2 answer (`X-Feed-Stale: 1`), else the frozen
v1 collection (`v1-fallback`), else a 502. Degraded answers are cached for 60 s.

## Commands

```sh
scripts/meetings-switch.sh status   # what is live + v1-vs-v2 comparison
scripts/meetings-switch.sh v2       # cut over
scripts/meetings-switch.sh v1       # ROLL BACK
COMPARE_VALUES=1 scripts/meetings-switch.sh status   # include the differing values (keep out of public places)
```

A switch commits only the switch file to `main`, after the tests, type check
and build pass, then waits until production answers from the target and prints
the comparison. Netlify deploys `main` in about a minute; edge caches can serve
the previous answer for up to 5 minutes.

`v2` refuses unless `INCLUDE_DRAFTS = false`, production's `?source=v1` and
`?source=v2` answer as themselves and match exactly (`ALLOW_DRIFT=1` for a
switch forward after a rollback), and the time is outside :33–:47 (the hourly
geocoder reads the switch when it starts at :37). `v1` runs only the build
(`SKIP_CHECKS=1` skips it) so a test can never block an emergency. A failed
push undoes the local commit.

**Fastest rollback (no git):** Netlify → aa-manitoba-api → Deploys → a deploy
made after the switch was installed (it carries `X-Meetings-Source`) but before
the v2 switch → **Publish deploy**. This LOCKS auto-publishing: run
`scripts/meetings-switch.sh v1` so `main` matches production, then unlock
("Enable auto publishing"), or later fixes to `main` never go live.

**Policy: fix forward by default.** Roll back only when the feed itself is
broken (wrong or missing meetings for visitors). An editor confusion is fixed
in the CMS, not by switching.

## What a rollback costs

There is no continuous v2→v1 mirror. Rolling back shows the old collection as
it was at the cutover, so edits made in Groups / Group Meetings after the
cutover disappear from the site until they are re-entered there. The
comparison the rollback prints is exactly that list (`~` changed, `+` added in
v2, `-` removed in v2); run with `COMPARE_VALUES=1` for the values. If the v2
reader is the thing that broke, that list is incomplete: take the edits from
Webflow (sort Groups / Group Meetings by last updated). Meetings created in v2
need new items in v1, so their links change. Tell the editors which
collection to use after any switch.

Note for editors on v2: a group's address, pin, online link and contacts are
shared by all its meetings, and the geocoder re-pins the whole group when its
address changes (an online-only group whose address is edited becomes
in-person + online, as in v1).

## Cutover sequence (2026-11-17)

1. Fresh backup of all three collections (local, private) and a freeze check:
   no v1 edits since the import other than the approved fixes, and a local
   dry run of the sync planned 0 changes, so v2 matched v1 in every field.
2. Deploy the switch with `source: v1` (no visible change); confirm
   `?source=v1` equals the previous feed and `?source=v2` equals it too.
3. Make every Group and every visible Group Meeting non-draft (the 4 meetings
   that were drafts in v1 stay drafts); deploy `INCLUDE_DRAFTS = false` so
   "draft = hidden" works as it did in v1; confirm parity again.
4. `scripts/meetings-switch.sh v2`; verify the feed, the finder and the
   geocoder run on Groups.
5. Rehearse the rollback (`v1`, verify) and switch forward again (`v2`) while
   both collections still hold identical data.
6. Rename the collections so editors use the new ones; tell the editors.

## Follow-ups (not needed for the switch)

- Collection slug swap (v2 Group Meetings → `meetings`, v1 → `meetings-legacy`)
  so `/meetings/{slug}` CMS pages come from v2; today the v1 pages keep
  redirecting into the finder by slug, which still works.
- Exclude the v2 template pages from the sitemap (Designer, page settings).
- Retire v1 and this switch after the rollback window.
