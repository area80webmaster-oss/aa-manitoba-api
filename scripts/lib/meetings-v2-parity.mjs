// Pure comparison of the live /meetings feed (v1) against /meetings-v2.
// No I/O, so the rules are unit-tested offline.
//
// Rules, and why:
//   • Rows are matched by slug, as sets: order is a presentation detail, the
//     slug is what TSML links and the Meeting Guide app key on.
//   • 'updated' is ignored: it is each collection's own edit timestamp, and
//     the v2 items are rewritten by the sync, so it can never agree.
//   • Key order is ignored; key presence is not (an absent field and a null
//     one are different JSON for a consumer).
//   • Strings that differ only by outer whitespace are equal: v2 values are
//     trimmed by the derivation (a vote on " Hall" vs "Hall" must not split),
//     and the rendered meeting finder trims both anyway.
//
// Results carry slugs and field names only — the logs are public.

export const MIN_ROW_RATIO = 0.9;
const IGNORED = new Set(['updated']);

const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

export function sameValue(a, b) {
  if (typeof a === 'string' && typeof b === 'string') return a.trim() === b.trim();
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => sameValue(x, b[i]));
  if (isRecord(a) && isRecord(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((k) => k in a && k in b && sameValue(a[k], b[k]));
  }
  return a === b;
}

function index(rows) {
  const bySlug = new Map();
  const duplicates = new Set();
  let invalid = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isRecord(row) || typeof row.slug !== 'string' || row.slug === '') {
      invalid++;
      continue;
    }
    if (bySlug.has(row.slug)) duplicates.add(row.slug);
    else bySlug.set(row.slug, row);
  }
  return { bySlug, duplicates: [...duplicates].sort(), invalid };
}

export function compareFeeds(v1Rows, v2Rows) {
  const a = index(v1Rows);
  const b = index(v2Rows);
  const onlyV1 = [...a.bySlug.keys()].filter((s) => !b.bySlug.has(s)).sort();
  const onlyV2 = [...b.bySlug.keys()].filter((s) => !a.bySlug.has(s)).sort();
  const differing = [];
  for (const [slug, r1] of a.bySlug) {
    const r2 = b.bySlug.get(slug);
    if (!r2) continue;
    const fields = [...new Set([...Object.keys(r1), ...Object.keys(r2)])]
      .filter((k) => !IGNORED.has(k))
      .filter((k) => !(k in r1 && k in r2 && sameValue(r1[k], r2[k])))
      .sort();
    if (fields.length) differing.push({ slug, fields });
  }
  differing.sort((x, y) => (x.slug < y.slug ? -1 : 1));
  return {
    v1Rows: Array.isArray(v1Rows) ? v1Rows.length : 0,
    v2Rows: Array.isArray(v2Rows) ? v2Rows.length : 0,
    onlyV1,
    onlyV2,
    differing,
    duplicates: { v1: a.duplicates, v2: b.duplicates },
    invalid: { v1: a.invalid, v2: b.invalid },
  };
}

export function parityProblems(result, minRatio = MIN_ROW_RATIO) {
  const problems = [];
  // Checked first and on its own: an empty or collapsed v2 feed is the one
  // failure where people would find no meetings at all after cutover.
  if (result.v2Rows < result.v1Rows * minRatio) {
    problems.push(`/meetings-v2 has ${result.v2Rows} rows, under ${Math.round(minRatio * 100)}% of /meetings' ${result.v1Rows}`);
  }
  if (result.onlyV1.length) problems.push(`${result.onlyV1.length} rows only in /meetings`);
  if (result.onlyV2.length) problems.push(`${result.onlyV2.length} rows only in /meetings-v2`);
  if (result.differing.length) problems.push(`${result.differing.length} rows differ`);
  for (const feed of ['v1', 'v2']) {
    if (result.duplicates[feed].length) problems.push(`${result.duplicates[feed].length} duplicated slugs in ${feed}`);
    if (result.invalid[feed]) problems.push(`${result.invalid[feed]} rows without a slug in ${feed}`);
  }
  return problems;
}
