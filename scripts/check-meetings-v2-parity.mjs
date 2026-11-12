// Parity check: the public /meetings feed (v1, what people use today) must
// equal /meetings-v2 (built from Groups + Group Meetings), so cutover changes
// nothing a visitor can see. Runs after every sync in the workflow; rules in
// scripts/lib/meetings-v2-parity.mjs.
//
// Read-only: two GETs against the public API, no token. The ?fresh= value is
// unique per run so the CDN cache can't answer with an older copy of either
// feed. Redirects are refused: the site's catch-all sends unknown paths to
// /meetings, and comparing /meetings with itself would always "pass".
//
// Logs are public: counts, slugs and field names only, never values.
//
// Exit 1 on any visible difference, or when /meetings-v2 has under 90% of
// /meetings' rows.

import { compareFeeds, parityProblems } from './lib/meetings-v2-parity.mjs';

const BASE = 'https://api.aamanitoba.org';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One retry: a cold function can miss its time limit once and serve a 502,
// which is worth a second look before paging anyone.
async function fetchFeed(path) {
  let last = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await sleep(5000);
    try {
      const res = await fetch(`${BASE}${path}?fresh=${Date.now()}`, {
        headers: { Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        last = `${path} → HTTP ${res.status}`;
        await res.body?.cancel();
        continue;
      }
      const body = await res.json();
      if (!Array.isArray(body)) throw new Error(`${path}: response is not an array`);
      return body;
    } catch (err) {
      // A parse error's message quotes the body; keep only its name.
      last = `${path} → ${err?.name === 'SyntaxError' || err?.name === 'TimeoutError' ? err.name : err?.message}`;
    }
  }
  throw new Error(last);
}

try {
  const [v1, v2] = await Promise.all([fetchFeed('/meetings'), fetchFeed('/meetings-v2')]);
  const result = compareFeeds(v1, v2);
  console.log(`/meetings: ${result.v1Rows} rows; /meetings-v2: ${result.v2Rows} rows`);
  for (const s of result.onlyV1) console.log(`  only in /meetings: ${s}`);
  for (const s of result.onlyV2) console.log(`  only in /meetings-v2: ${s}`);
  for (const d of result.differing) console.log(`  differs: ${d.slug} [${d.fields.join(', ')}]`);
  for (const feed of ['v1', 'v2']) for (const s of result.duplicates[feed]) console.log(`  duplicate slug in ${feed}: ${s}`);
  const problems = parityProblems(result);
  for (const p of problems) console.log(`ERROR ${p}`);
  console.log(JSON.stringify({
    v1Rows: result.v1Rows,
    v2Rows: result.v2Rows,
    onlyV1: result.onlyV1.length,
    onlyV2: result.onlyV2.length,
    differing: result.differing.length,
    ok: problems.length === 0,
  }));
  process.exitCode = problems.length ? 1 : 0;
} catch (err) {
  console.error(`FATAL ${err?.name === 'SyntaxError' ? err.name : err?.message}`);
  process.exitCode = 1;
}
