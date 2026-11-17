// Hourly health check of the public meeting list. Fails the job (which emails
// the repo) when people could be missing a meeting:
//   • /meetings answers from the wrong reader, a stale copy or the v1 fallback;
//   • it lists fewer than MIN_ROWS meetings;
//   • on v2: a Group Meeting that should be public (not draft/archived/hidden,
//     its group visible, inside its date window) is not in the public feed,
//     or one is skipped for a broken group or missing day. The expected list
//     comes from the same buildFeed the route uses.
// It also warns (without failing) about likely editor slips: a meeting
// created as a draft since the cutover, and a draft/hidden group that still
// holds meetings meant to be public.
//
// Read-only. The repo and its logs are PUBLIC: prints slugs and counts only.
// Node 22.18+/24 (imports the route's TypeScript modules directly).
// Env: WEBFLOW_WRITE_TOKEN (only read here).
import { readSource } from './lib/meetings-source.mjs';
import { GROUPS_COLLECTION_ID, GROUP_MEETINGS_COLLECTION_ID, INCLUDE_DRAFTS } from '../src/lib/meetings-v2/config.ts';
import { buildFeed, manitobaToday } from '../src/lib/meetings-v2/feed.ts';
import { getDayOptions, listAllItems } from '../src/lib/meetings-v2/webflow.ts';

const API = 'https://api.aamanitoba.org/meetings';
// Stricter than the route's own 300-row floor on purpose: the route keeps
// serving between 300 and 350, but a drop that large deserves a human.
const MIN_ROWS = 350;
// An editor saving between the CMS read and the feed read (or items shifting
// across pages mid-read) looks like a mismatch; one recheck settles it.
const RECHECK_MS = 330_000;
// A switch push starts this job while Netlify is still deploying, so a wrong
// source or a stale copy is waited out for up to 10 minutes before it counts.
const SETTLE_TRIES = 20;
const SETTLE_MS = 30_000;

const { source, since } = readSource();
const problems = [];
const warnings = [];

async function publicFeed() {
  const res = await fetch(`${API}?cb=${Date.now()}`, { headers: { 'cache-control': 'no-cache' } });
  const rows = res.ok ? await res.json() : null;
  return {
    ok: res.ok && Array.isArray(rows),
    status: res.status,
    source: res.headers.get('x-meetings-source'),
    stale: res.headers.get('x-feed-stale'),
    rows: Array.isArray(rows) ? rows : []
  };
}

function checkServing(feed) {
  const out = [];
  if (!feed.ok) out.push(`/meetings answered HTTP ${feed.status}`);
  if (feed.source !== source) out.push(`/meetings answers from "${feed.source}" but the switch says "${source}"`);
  if (feed.stale) out.push('/meetings is serving a stale copy (the v2 build is failing)');
  if (feed.ok && feed.rows.length < MIN_ROWS) out.push(`/meetings lists only ${feed.rows.length} meetings (expected at least ${MIN_ROWS})`);
  return out;
}

async function expectedV2(token) {
  const [groups, meetings, dayOptions] = await Promise.all([
    listAllItems(GROUPS_COLLECTION_ID, token, Date.now() + 60_000),
    listAllItems(GROUP_MEETINGS_COLLECTION_ID, token, Date.now() + 60_000),
    getDayOptions(GROUP_MEETINGS_COLLECTION_ID, token, Date.now() + 60_000)
  ]);
  const { rows, skipped } = buildFeed(groups, meetings, dayOptions, manitobaToday(), INCLUDE_DRAFTS);
  return { groups, meetings, slugs: new Set(rows.map((r) => r.slug)), skipped };
}

function diff(expected, feed) {
  const served = new Set(feed.rows.map((r) => r.slug));
  return {
    missing: [...expected.slugs].filter((s) => !served.has(s)).sort(),
    extra: [...served].filter((s) => !expected.slugs.has(s)).sort()
  };
}

let feed = await publicFeed();
for (let i = 0; i < SETTLE_TRIES && checkServing(feed).length; i++) {
  console.log(`Waiting for /meetings to settle: ${checkServing(feed).join('; ')}`);
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  feed = await publicFeed();
}
problems.push(...checkServing(feed));

if (source === 'v2') {
  const token = process.env.WEBFLOW_WRITE_TOKEN;
  if (!token) {
    console.error('WEBFLOW_WRITE_TOKEN is not set.');
    process.exit(1);
  }
  let expected = await expectedV2(token);
  let d = diff(expected, feed);
  if ((d.missing.length || d.extra.length) && !problems.length) {
    console.log(`Mismatch (${d.missing.length} missing, ${d.extra.length} extra); rechecking after the cache window…`);
    await new Promise((r) => setTimeout(r, RECHECK_MS));
    feed = await publicFeed();
    expected = await expectedV2(token);
    d = diff(expected, feed);
  }
  for (const s of d.missing) problems.push(`should be public but is not in /meetings: ${s}`);
  for (const s of d.extra) problems.push(`in /meetings but should not be: ${s}`);
  for (const [slug, reason] of expected.skipped) problems.push(`left out of the feed (${reason}): ${slug}`);

  const cutover = Date.parse(since);
  for (const m of expected.meetings) {
    if (m.isDraft && !m.isArchived && Date.parse(m.createdOn ?? '') > cutover) {
      warnings.push(`draft meeting created since the cutover (not public until it is saved as non-draft): ${m.fieldData?.slug}`);
    }
  }
  const groupById = new Map(expected.groups.map((g) => [g.id, g]));
  const flagged = new Set();
  for (const m of expected.meetings) {
    const g = groupById.get(m.fieldData?.group);
    if (!g || m.isDraft || m.isArchived || m.fieldData?.['hide-from-meeting-finder']) continue;
    const blocked = g.isDraft || g.isArchived || g.fieldData?.['hide-from-meeting-finder'];
    if (blocked && !flagged.has(g.id)) {
      flagged.add(g.id);
      warnings.push(`group is draft, archived or hidden, so its public meetings are not shown: ${g.fieldData?.slug}`);
    }
  }
}

console.log(`source ${source}; /meetings answers ${feed.source} with ${feed.rows.length} meetings${feed.stale ? ' (stale)' : ''}.`);
for (const w of warnings) console.log(`::warning::${w}`);
for (const p of problems) console.log(`::error::${p}`);
if (problems.length) {
  console.log(`${problems.length} problem(s): someone looking for a meeting may not find it.`);
  process.exit(1);
}
console.log(`OK${warnings.length ? ` (${warnings.length} warning(s))` : ''}.`);
