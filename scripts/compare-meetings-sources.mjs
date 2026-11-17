// Compares what /meetings serves from each reader: ?source=v1 (the flat
// Meetings collection) against ?source=v2 (Groups + Group Meetings), using the
// same public URL TSML UI and the Meeting Guide app read.
//
// Before the cutover the two must match (parity). After it they drift by
// exactly the edits volunteers made in the new collections, so on a rollback
// this is the list of changes the old collection is missing.
//
// Run: node scripts/compare-meetings-sources.mjs [--values] [--require-identical] [--base=https://api.aamanitoba.org]
// Prints slugs and field names; --values adds the differing values (public
// feed data, but keep it out of the public repo and its CI logs).
// Exit code: 0 = compared, 2 = a reader failed, 3 = --require-identical and
// the readers differ, or one did not answer as itself (fallback, stale, old build).

const args = process.argv.slice(2);
const showValues = args.includes('--values');
const requireIdentical = args.includes('--require-identical');
const base = (args.find((a) => a.startsWith('--base='))?.slice(7) || 'https://api.aamanitoba.org').replace(/\/$/, '');
// `updated` differs by design (v1 = last publish, v2 = last edit).
const IGNORED = new Set(['updated']);

const norm = (v) =>
  typeof v === 'string' ? v.split(/\s+/).filter(Boolean).join(' ') : Array.isArray(v) ? v.map(norm) : v;

async function read(query) {
  const url = `${base}/meetings?${query}&cb=${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
  const res = await fetch(url, { headers: { 'cache-control': 'no-cache' } });
  const body = await res.text();
  if (!res.ok) throw new Error(`${query || 'default'}: HTTP ${res.status}`);
  const rows = JSON.parse(body);
  if (!Array.isArray(rows)) throw new Error(`${query || 'default'}: not a JSON array`);
  return { rows, source: res.headers.get('x-meetings-source'), stale: res.headers.get('x-feed-stale') };
}

let v1;
let v2;
let live;
try {
  [v1, v2, live] = await Promise.all([read('source=v1'), read('source=v2'), read('')]);
} catch (err) {
  console.error(`A reader failed: ${err.message}`);
  process.exit(2);
}

console.log(`/meetings now serves: ${live.source ?? '(no X-Meetings-Source header: old build)'}${live.stale ? ' (stale copy)' : ''}, ${live.rows.length} meetings`);
console.log(`?source=v1 → ${v1.source}, ${v1.rows.length} meetings`);
console.log(`?source=v2 → ${v2.source}${v2.stale ? ' (stale copy)' : ''}, ${v2.rows.length} meetings`);
const honest = v1.source === 'v1' && v2.source === 'v2' && !v2.stale;
if (!honest) {
  console.log('WARNING: a reader did not answer as itself (fallback, stale copy or old build); the comparison below may not mean what it says.');
}

const index = (rows) => new Map(rows.map((r) => [r.slug, r]));
const a = index(v1.rows);
const b = index(v2.rows);
const onlyV1 = [...a.keys()].filter((s) => !b.has(s)).sort();
const onlyV2 = [...b.keys()].filter((s) => !a.has(s)).sort();
let visible = 0;
let whitespace = 0;
const lines = [];
for (const slug of [...a.keys()].filter((s) => b.has(s)).sort()) {
  const x = a.get(slug);
  const y = b.get(slug);
  const fields = [...new Set([...Object.keys(x), ...Object.keys(y)])].filter(
    (k) => !IGNORED.has(k) && JSON.stringify(x[k]) !== JSON.stringify(y[k])
  );
  if (!fields.length) continue;
  const real = fields.filter((k) => JSON.stringify(norm(x[k])) !== JSON.stringify(norm(y[k])));
  if (!real.length) {
    whitespace++;
    continue;
  }
  visible++;
  lines.push(`  ~ ${slug}: ${real.join(', ')}`);
  if (showValues) for (const k of real) lines.push(`      ${k}: v1=${JSON.stringify(x[k])}  v2=${JSON.stringify(y[k])}`);
}

console.log(
  `\nv1 vs v2: ${onlyV1.length} only in v1, ${onlyV2.length} only in v2, ${visible} differ, ${whitespace} whitespace-only`
);
for (const s of onlyV1) console.log(`  - only in v1: ${s}`);
for (const s of onlyV2) console.log(`  + only in v2: ${s}`);
for (const l of lines) console.log(l);
const identical = !onlyV1.length && !onlyV2.length && !visible;
if (identical) console.log('IDENTICAL (apart from whitespace and `updated`).');
if (requireIdentical && !(identical && honest)) {
  console.log('NOT SAFE TO SWITCH: the readers must both answer as themselves and match exactly.');
  process.exit(3);
}
