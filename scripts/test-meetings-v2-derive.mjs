// Run: node scripts/test-meetings-v2-derive.mjs
//
// Proves, without any network, that the v2 sync derives exactly what the
// Python reference derives, that its write guard refuses everything but v2
// draft writes, and that its planner and apply path follow the sync rules.
//
// Real data (the v1 backup and the Python outputs) is PRIVATE — contact names,
// emails and phones. It is read in place, never copied into the repo, and only
// counts are printed. Those checks skip themselves when the files are absent
// (CI), so the guard and planner tests still gate every run there.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DAYS, migrate } from './lib/meetings-v2-derive.mjs';
import { GROUP_FIELDS, MEETING_FIELDS, planSync } from './lib/meetings-v2-plan.mjs';
import { V2_GROUPS_ID, V2_MEETINGS_ID, assertWriteAllowed, resolveMode, runSync, write } from './sync-meetings-v2.mjs';

const here = dirname(fileURLToPath(import.meta.url));
// Optional real-data checks: the backup and Python outputs hold private
// contact details, so they live outside this public repo and are found via
// MEETINGS_V2_PRIVATE_DIR; without it (e.g. in CI) those checks skip.
const AA = process.env.MEETINGS_V2_PRIVATE_DIR ?? '/nonexistent';
const BACKUP = `${AA}/backups/meetings-2026-11-12-post-fixes/meetings-items-staged.json`;
const PY_OUT = `${AA}/meetings-restructure/out`;
const PY_REF = `${AA}/meetings-restructure/tools/migrate_v1_to_v2.py`;
const V1_ID = '6a101256165031ecf1106518';

let failures = 0;
let passes = 0;
function check(label, fn) {
  try {
    fn();
    passes++;
    console.log(`  ok   ${label}`);
  } catch (err) {
    failures++;
    // Assertion messages here are written to name counts/slugs/fields only.
    console.log(`  FAIL ${label}: ${err.message.split('\n')[0]}`);
  }
}
async function checkAsync(label, fn) {
  try {
    await fn();
    passes++;
    console.log(`  ok   ${label}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${label}: ${err.message.split('\n')[0]}`);
  }
}
const silent = () => {};
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

// Compares two record lists without ever printing a value.
function compareRecords(label, js, py) {
  check(`${label}: ${js.length} JS vs ${py.length} Python records`, () => assert.equal(js.length, py.length, 'count differs'));
  let exact = 0;
  const differing = new Set();
  for (let i = 0; i < Math.max(js.length, py.length); i++) {
    if (JSON.stringify(js[i]) === JSON.stringify(py[i])) {
      exact++;
      continue;
    }
    const a = js[i]?.fieldData ?? js[i] ?? {};
    const b = py[i]?.fieldData ?? py[i] ?? {};
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) differing.add(k);
    }
    if (!differing.size) differing.add('(key order or envelope)');
  }
  check(`${label}: ${exact}/${py.length} identical (all fields, key order included)`, () =>
    assert.equal(exact, py.length, `differing fields: ${[...differing].join(', ')}`)
  );
}

// ── (a) Real backup: JS derivation vs the Python outputs ────────────────────
console.log('(a) parity with the Python reference on the real backup');
if ([BACKUP, `${PY_OUT}/v2-groups.json`, `${PY_OUT}/v2-meetings.json`].every(existsSync)) {
  const out = migrate(readJson(BACKUP));
  compareRecords('groups', out.groups, readJson(`${PY_OUT}/v2-groups.json`));
  compareRecords('meetings', out.meetings, readJson(`${PY_OUT}/v2-meetings.json`));
  if (existsSync(`${PY_OUT}/v2-conflicts.json`)) compareRecords('conflicts', out.conflicts, readJson(`${PY_OUT}/v2-conflicts.json`));
} else console.log('  skip (private backup not present)');

// ── (a2) Edge cases run through the Python itself ───────────────────────────
// Whitespace sets, tie-breaks, draft voting, slug suffixes and online
// overrides are where a port drifts; the real backup may not exercise them.
console.log('(a2) parity with the Python reference on synthetic edge cases');
function edgeItems() {
  let n = 0;
  const item = (fd, extra = {}) => ({
    id: extra.id ?? `e${String(++n).padStart(3, '0')}`,
    createdOn: extra.createdOn === undefined ? `2026-01-${String(10 + (n % 15)).padStart(2, '0')}T00:00:00.000Z` : extra.createdOn,
    isDraft: extra.isDraft ?? false,
    isArchived: extra.isArchived ?? false,
    fieldData: {
      name: 'Meeting', slug: `edge-${n}`, day: 'Monday', time: '19:00', address: '1 Test St, Town, MB R0A 0A0, Canada',
      group: null, author: ' Someone ', ...fd,
    },
  });
  return [
    item({ group: ' Shared﻿ Group ' }),
    item({ group: 'Shared Group' }),
    item({ group: 'shared   GROUP', name: 'Shared Group' }),
    item({ group: 'X\u0085Y', location: 'Hall A' }),
    item({ group: 'x y', location: 'Hall B' }),
    item({ group: '\u001cEdge Name\u001f', name: ' Edge Name ' }),
    item({ name: 'Rural Meeting', address: '9 Main St, Town, MB' }),
    item({ name: ' rural  meeting', address: '9 MAIN ST,  Town, MB' }),
    item({ name: 'Shared Group', address: 'Elsewhere' }),
    item({ group: 'Draft Only', location: 'L1' }, { isDraft: true }),
    item({ group: 'Draft Only', location: 'L2' }, { isDraft: true }),
    item({ group: 'Mixed', location: 'Draft Hall' }, { isDraft: true }),
    item({ group: 'Mixed', location: 'Draft Hall' }, { isDraft: true }),
    item({ group: 'Mixed', location: 'Real Hall' }),
    item({ group: 'Tie', location: 'T-new' }, { id: '\u{1F600}', createdOn: '2026-02-01T00:00:00.000Z' }),
    item({ group: 'Tie', location: 'T-old' }, { id: '￿', createdOn: '2026-02-01T00:00:00.000Z' }),
    item({ group: 'Online', 'conference-url': 'https://zoom.example/a', 'conference-url-notes': '<p>pw 1</p>' }),
    item({ group: 'Online', 'conference-url': 'https://zoom.example/a', 'conference-url-notes': '<p>pw 1</p>' }),
    item({ group: 'Online', 'conference-url': null, 'conference-url-notes': '<p>pw 1</p>' }),
    item({ group: 'Online', 'conference-url': 'https://zoom.example/b', 'conference-url-notes': '<p>pw 2</p>' }),
    item({ group: 'Online', 'conference-url': 'https://zoom.example/a ', 'conference-url-notes': null }),
    item({ group: 'Online', 'conference-url': null, 'conference-url-notes': null }),
    item({ group: 'Rich', 'location-notes': '<p>Side door</p>' }),
    item({ group: 'Rich', 'location-notes': '<div>Side   door</div>' }),
    item({ group: 'Rich', 'location-notes': '<p>Side door</p>', 'contact-1-email': 'a@example.org' }),
    item({ group: 'Rich', 'location-notes': '<p>Side door</p>', 'contact-1-email': 'b@example.org' }),
    item({ group: 'Rich', 'location-notes': '<p>Side door</p>', 'contact-1-email': 'b@example.org' }),
    item({ group: 'No Day', day: null, time: null }),
    item({ group: 'No Created' }, { createdOn: null }),
    item({ group: 'Archived Only' }, { isArchived: true }),
    item({ group: '  ' , name: 'Blank Group Is Standalone' }),
    item({ group: '---' }),
    item({ group: 'Rural Meeting' }),
  ];
}
let python = null;
try {
  execFileSync('python3', ['-I', '-c', 'pass'], { stdio: 'ignore' });
  python = 'python3';
} catch {}
if (python && existsSync(PY_REF)) {
  const dir = mkdtempSync(join(tmpdir(), 'meetings-v2-edge-'));
  try {
    const items = edgeItems();
    writeFileSync(join(dir, 'in.json'), JSON.stringify(items));
    execFileSync(python, ['-I', PY_REF, join(dir, 'in.json'), join(dir, 'out')], { stdio: 'ignore' });
    const out = migrate(items);
    compareRecords('edge groups', out.groups, readJson(join(dir, 'out', 'v2-groups.json')));
    compareRecords('edge meetings', out.meetings, readJson(join(dir, 'out', 'v2-meetings.json')));
    compareRecords('edge conflicts', out.conflicts, readJson(join(dir, 'out', 'v2-conflicts.json')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
} else console.log('  skip (python3 or the reference script not present)');

// ── (b) Write guard ─────────────────────────────────────────────────────────
console.log('(b) write guard');
const syncSrc = readFileSync(join(here, 'sync-meetings-v2.mjs'), 'utf8');
const libSrc = ['lib/meetings-v2-derive.mjs', 'lib/meetings-v2-plan.mjs'].map((f) => readFileSync(join(here, f), 'utf8'));

function functionBody(src, header) {
  const start = src.indexOf(header);
  assert.ok(start >= 0, `function not found: ${header}`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced: ${header}`);
}

check('v1 collection ID literal appears once, as a non-exported GET-only constant', () => {
  const lines = syncSrc.split('\n').filter((l) => l.includes(V1_ID));
  assert.equal(lines.length, 1, `${lines.length} occurrences`);
  assert.match(lines[0], /^const V1_COLLECTION_ID = '[0-9a-f]{24}'; \/\/ .*GET only/);
});
check('v1 constant is used only as an argument to the paginated reader', () => {
  const uses = syncSrc.split('\n').filter((l) => l.includes('V1_COLLECTION_ID') && !l.startsWith('const V1_COLLECTION_ID ='));
  assert.equal(uses.length, 1, `${uses.length} uses`);
  assert.match(uses[0], /^\s*const v1Items = await client\.readAllItems\(V1_COLLECTION_ID\);$/);
});
check('the reader and get() only issue GETs', () => {
  const reader = functionBody(syncSrc, 'async function readAllItems(');
  assert.ok(!/method|write\(|request\(|POST|PATCH|DELETE/.test(reader), 'readAllItems does more than get()');
  assert.match(functionBody(syncSrc, 'function get(path)'), /^function get\(path\) \{\s*return request\('GET', path\);\s*\}$/);
});
check('fetch is called in exactly one place, and request() only from get/write/retry', () => {
  assert.equal(syncSrc.split('fetch(').length - 1, 1);
  const callers = syncSrc.split('\n').filter((l) => /\brequest\(/.test(l));
  assert.deepEqual(
    callers.map((l) => l.trim()),
    [
      'async function request(method, path, body, attempt = 0) {',
      'return request(method, path, body, attempt + 1);',
      "return request('GET', path);",
      'return await request(method, path, body);',
    ]
  );
  assert.match(functionBody(syncSrc, 'export async function write('), /^export async function write\(method, collectionId, path, body\) \{\s*assertWriteAllowed\(method, collectionId, path, body\);/);
});
check('every client.write call targets a v2 constant', () => {
  const calls = syncSrc.split('\n').filter((l) => l.includes('client.write('));
  assert.ok(calls.length >= 4);
  for (const l of calls) assert.match(l, /client\.write\('(POST|PATCH)', (V2_GROUPS_ID|V2_MEETINGS_ID), `\/collections\/\$\{\2\}\/items`/);
});
check('pure libs contain no network calls and no v1 ID', () => {
  for (const src of libSrc) assert.ok(!src.includes('fetch(') && !src.includes(V1_ID));
});
check('committed config is dry-run, SYNC_MODE overrides it, junk is refused', () => {
  assert.deepEqual(readJson(join(here, 'sync-meetings-v2.config.json')), { mode: 'dry-run' });
  assert.equal(resolveMode({}), 'dry-run');
  assert.equal(resolveMode({ SYNC_MODE: 'apply' }), 'apply');
  assert.throws(() => resolveMode({ SYNC_MODE: 'yes' }));
});

const okPost = { items: [{ fieldData: { name: 'x' }, isDraft: true, isArchived: false }] };
const okPatch = { items: [{ id: 'abc', fieldData: { name: 'x' } }] };
const p = (id) => `/collections/${id}/items`;
check('guard accepts the four legitimate writes', () => {
  for (const id of [V2_GROUPS_ID, V2_MEETINGS_ID]) {
    assertWriteAllowed('POST', id, p(id), okPost);
    assertWriteAllowed('PATCH', id, p(id), okPatch);
  }
});
check('guard refuses v1, unknown collections, DELETE/PUT/GET, /live, /publish, other paths', () => {
  assert.throws(() => assertWriteAllowed('PATCH', V1_ID, p(V1_ID), okPatch));
  assert.throws(() => assertWriteAllowed('POST', V1_ID, p(V1_ID), okPost));
  assert.throws(() => assertWriteAllowed('PATCH', V2_GROUPS_ID, p(V1_ID), okPatch));
  assert.throws(() => assertWriteAllowed('PATCH', 'deadbeef', p('deadbeef'), okPatch));
  for (const m of ['DELETE', 'PUT', 'GET', 'patch']) assert.throws(() => assertWriteAllowed(m, V2_GROUPS_ID, p(V2_GROUPS_ID), okPatch));
  for (const suffix of ['/live', '/publish', '/bulk', '/abc']) {
    assert.throws(() => assertWriteAllowed('PATCH', V2_GROUPS_ID, p(V2_GROUPS_ID) + suffix, okPatch));
  }
  assert.throws(() => assertWriteAllowed('POST', V2_GROUPS_ID, `/collections/${V2_GROUPS_ID}/items/publish`, okPost));
});
check('guard refuses published, archived or oversized bodies', () => {
  const id = V2_MEETINGS_ID;
  assert.throws(() => assertWriteAllowed('POST', id, p(id), { items: [{ fieldData: {}, isDraft: false, isArchived: false }] }));
  assert.throws(() => assertWriteAllowed('POST', id, p(id), { items: [{ fieldData: {}, isArchived: false }] }));
  assert.throws(() => assertWriteAllowed('POST', id, p(id), { items: [{ fieldData: {}, isDraft: true, isArchived: true }] }));
  assert.throws(() => assertWriteAllowed('PATCH', id, p(id), { items: [{ id: 'a', fieldData: {}, isDraft: true }] }));
  assert.throws(() => assertWriteAllowed('PATCH', id, p(id), { items: [{ id: 'a', fieldData: {}, isArchived: false }] }));
  assert.throws(() => assertWriteAllowed('PATCH', id, p(id), { items: [] }));
  assert.throws(() => assertWriteAllowed('PATCH', id, p(id), { items: Array.from({ length: 101 }, () => okPatch.items[0]) }));
});

// write() itself: the network is replaced so a guard failure would show up as
// a recorded fetch rather than a real request.
const realFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = async () => {
  fetchCalls++;
  throw new Error('network disabled in test');
};
await checkAsync('write() with the v1 ID, DELETE, or a /live path throws before any fetch', async () => {
  await assert.rejects(write('PATCH', V1_ID, p(V1_ID), okPatch), /write refused/);
  await assert.rejects(write('POST', V1_ID, p(V1_ID), okPost), /write refused/);
  await assert.rejects(write('DELETE', V2_GROUPS_ID, p(V2_GROUPS_ID), okPatch), /write refused/);
  await assert.rejects(write('PATCH', V2_GROUPS_ID, `${p(V2_GROUPS_ID)}/live`, okPatch), /write refused/);
  await assert.rejects(write('POST', V2_MEETINGS_ID, `${p(V2_MEETINGS_ID)}/live`, okPost), /write refused/);
  assert.equal(fetchCalls, 0, `${fetchCalls} fetches`);
});
globalThis.fetch = realFetch;

// ── (c) Planner on synthetic data ───────────────────────────────────────────
console.log('(c) planner');
const dayOptions = DAYS.map((name, i) => ({ id: `day-${i}`, name }));
let seq = 0;
const v1Item = (id, fd, extra = {}) => ({
  id, createdOn: `2026-03-${String(++seq).padStart(2, '0')}T00:00:00.000Z`, isDraft: false, isArchived: false, ...extra,
  fieldData: { name: 'Meeting', slug: `m-${id}`, day: 'Tuesday', time: '20:00', address: '5 Elm St, Winnipeg, MB R2C 0A1, Canada', group: null, location: 'Church Hall', author: 'Volunteer', ...fd },
});
// What Webflow hands back after a create: every field present, unset ones null.
const asStored = (fields, fd, id, extra = {}) => ({
  id, isDraft: true, isArchived: false, createdOn: '2026-04-01T00:00:00.000Z', ...extra,
  fieldData: Object.fromEntries(fields.map((f) => [f, fd[f] === undefined || fd[f] === '' ? null : fd[f]])),
});

function synthetic() {
  const v1 = [
    v1Item('a1', { group: 'Alpha Group', name: 'Alpha Group', slug: 'alpha-tue', location: 'New Hall' }),
    v1Item('a2', { group: 'Alpha Group', name: 'Alpha Group', slug: 'alpha-wed', day: 'Wednesday', location: 'New Hall' }),
    v1Item('b1', { group: 'Beta Group', name: 'Beta Group', slug: 'beta-thu', day: 'Thursday' }),
    v1Item('c1', { group: 'Gamma Group', name: 'Gamma Group', slug: 'taken-slug', day: 'Friday' }),
    v1Item('x1', { group: 'Old Group', slug: 'old-mon', day: 'Monday' }, { isArchived: true }),
  ];
  const d = migrate(v1);
  const dg = (k) => d.groups.find((g) => g.key === k).fieldData;
  const dm = (id) => d.meetings.find((m) => m.legacyId === id).fieldData;
  const alphaStored = asStored(GROUP_FIELDS, { ...dg('g:alpha group'), slug: 'alpha-old', location: 'Old Hall' }, 'G-alpha');
  // Empty values in both spellings Webflow might use: '' and null.
  alphaStored.fieldData.website = '';
  const groups = [
    alphaStored,
    asStored(GROUP_FIELDS, { ...dg('g:alpha group'), name: 'Old Group', slug: 'old-group', 'legacy-group-key': 'g:old group' }, 'G-old'),
    asStored(GROUP_FIELDS, { name: 'Human Beta', slug: 'beta-group' }, 'G-human', { isDraft: false }),
  ];
  const a1 = asStored(MEETING_FIELDS, { ...dm('a1'), group: 'G-alpha', day: 'day-2' }, 'M-a1');
  a1.fieldData['hide-from-meeting-finder'] = null; // switch never set ≡ off
  const meetings = [
    a1,
    asStored(MEETING_FIELDS, { ...dm('a1'), slug: 'gone-1', group: 'G-alpha', day: 'day-1', 'legacy-item-id': 'gone' }, 'M-gone'),
    asStored(MEETING_FIELDS, { ...dm('a1'), slug: 'gone-2', group: 'G-alpha', day: 'day-1', 'legacy-item-id': 'gone2', 'hide-from-meeting-finder': true }, 'M-gone2'),
    asStored(MEETING_FIELDS, { name: 'Human meeting', slug: 'taken-slug' }, 'M-human'),
  ];
  return { v1, groups, meetings };
}

{
  const { v1, groups, meetings } = synthetic();
  const plan = planSync({ v1Items: v1, v2Groups: groups, v2Meetings: meetings, dayOptions });
  const gc = (k) => plan.groups.create.find((c) => c.key === k);
  check('create: missing groups are created as drafts', () => {
    assert.deepEqual(plan.groups.create.map((c) => c.key).sort(), ['g:beta group', 'g:gamma group']);
  });
  check('update: only the changed field is patched (slug never; ""/null and null-switch equal)', () => {
    assert.equal(plan.groups.update.length, 1);
    assert.deepEqual(plan.groups.update[0].fields, ['location']);
    assert.deepEqual(Object.keys(plan.groups.update[0].fieldData), ['location']);
    assert.equal(plan.groups.update[0].id, 'G-alpha');
  });
  check('unchanged: an identical meeting gets no update', () => {
    assert.ok(!plan.meetings.update.some((u) => u.id === 'M-a1'));
    assert.equal(plan.meetings.unchanged, 1);
  });
  check('retirement: a vanished key is hidden, an already hidden one is left alone', () => {
    assert.deepEqual(plan.meetings.retire.map((r) => [r.id, r.fieldData]), [['M-gone', { 'hide-from-meeting-finder': true }]]);
    assert.deepEqual(plan.groups.retire.map((r) => r.id), ['G-old']);
  });
  check('group slug collision: suffixed -2', () => {
    assert.equal(gc('g:beta group').slug, 'beta-group-2');
    assert.equal(gc('g:beta group').fieldData.slug, 'beta-group-2');
    assert.equal(gc('g:gamma group').slug, 'gamma-group');
  });
  check('meeting slug collision: error, not created', () => {
    assert.ok(!plan.meetings.create.some((c) => c.slug === 'taken-slug'));
    assert.equal(plan.errors.length, 1);
    assert.match(plan.errors[0], /^meeting taken-slug: slug is already used/);
    assert.ok(plan.skipped.meetings.has('c1'));
  });
  check('human-made items are reported and never targeted', () => {
    assert.deepEqual(plan.humanItems.map((h) => h.slug).sort(), ['beta-group', 'taken-slug']);
    const ids = [plan.groups, plan.meetings].flatMap((x) => [...x.update, ...x.retire].map((o) => o.id));
    assert.ok(!ids.includes('G-human') && !ids.includes('M-human'));
  });
  check('new meeting under an existing group gets its ID and day option ID', () => {
    const a2 = plan.meetings.create.find((c) => c.key === 'a2');
    assert.equal(a2.fieldData.group, 'G-alpha');
    assert.equal(a2.fieldData.day, 'day-3');
    assert.equal(a2.pendingGroup, null);
  });
  check('new meeting under a group created in the same run is pending, then resolves', () => {
    const b1 = plan.meetings.create.find((c) => c.key === 'b1');
    assert.equal(b1.pendingGroup, 'g:beta group');
    assert.ok(!('group' in b1.fieldData));
    const created = asStored(GROUP_FIELDS, gc('g:beta group').fieldData, 'G-beta-new');
    const plan2 = planSync({ v1Items: v1, v2Groups: [...groups, created], v2Meetings: meetings, dayOptions });
    const b1b = plan2.meetings.create.find((c) => c.key === 'b1');
    assert.equal(b1b.pendingGroup, null);
    assert.equal(b1b.fieldData.group, 'G-beta-new');
    assert.ok(!plan2.groups.create.some((c) => c.key === 'g:beta group'));
  });
  check('creates omit empty fields and never carry publish state', () => {
    for (const c of [...plan.groups.create, ...plan.meetings.create]) {
      assert.ok(Object.values(c.fieldData).every((v) => v !== null && v !== ''));
      assert.ok(!('isDraft' in c.fieldData) && !('isArchived' in c.fieldData));
    }
  });
  check('duplicate legacy key in v2: error and nothing written under it', () => {
    const dup = { ...structuredClone(groups[0]), id: 'G-alpha-dup' };
    const p2 = planSync({ v1Items: v1, v2Groups: [...groups, dup], v2Meetings: meetings, dayOptions });
    assert.ok(p2.errors.some((e) => e.includes('g:alpha group')));
    assert.ok(!p2.groups.update.some((u) => u.key === 'g:alpha group'));
    assert.ok(!p2.groups.create.some((c) => c.key === 'g:alpha group'));
    assert.ok(!p2.meetings.create.some((c) => c.groupKey === 'g:alpha group'));
  });
}

// ── (d) Apply path against an in-memory Webflow ─────────────────────────────
console.log('(d) apply path (in-memory Webflow)');
function fakeWebflow(v1, groups, meetings, days) {
  const store = { [V2_GROUPS_ID]: structuredClone(groups), [V2_MEETINGS_ID]: structuredClone(meetings) };
  const fields = { [V2_GROUPS_ID]: GROUP_FIELDS, [V2_MEETINGS_ID]: MEETING_FIELDS };
  const v1Snapshot = JSON.stringify(v1);
  const writes = [];
  let n = 0;
  return {
    store, writes,
    v1Untouched: () => JSON.stringify(v1) === v1Snapshot,
    readAllItems: async (id) => structuredClone(store[id] ?? v1),
    readDayOptions: async () => days,
    write: async (method, collectionId, path, body) => {
      assertWriteAllowed(method, collectionId, path, body);
      writes.push({ method, collectionId, count: body.items.length });
      if (method === 'POST') {
        const made = body.items.map((it) => asStored(fields[collectionId], it.fieldData, `new-${++n}`, { isDraft: it.isDraft }));
        store[collectionId].push(...made);
        return { items: structuredClone(made) };
      }
      for (const it of body.items) Object.assign(store[collectionId].find((x) => x.id === it.id).fieldData, it.fieldData);
      return { items: [] };
    },
  };
}

await checkAsync('synthetic apply: writes land, verify passes, only the known error remains', async () => {
  const { v1, groups, meetings } = synthetic();
  const wf = fakeWebflow(v1, groups, meetings, dayOptions);
  const humanBefore = JSON.stringify([wf.store[V2_GROUPS_ID][2], wf.store[V2_MEETINGS_ID][3]]);
  const { summary, ok } = await runSync({ mode: 'apply', client: wf, log: silent });
  assert.equal(ok, false); // the meeting slug collision is a reported error
  assert.equal(summary.errors, 1, `${summary.errors} errors`);
  assert.deepEqual(summary.create, { groups: 2, meetings: 2 });
  assert.deepEqual(summary.update, { groups: 1, meetings: 0 });
  assert.deepEqual(summary.retire, { groups: 1, meetings: 1 });
  assert.equal(JSON.stringify([wf.store[V2_GROUPS_ID][2], wf.store[V2_MEETINGS_ID][3]]), humanBefore);
  assert.ok(wf.v1Untouched());
  assert.ok(wf.writes.every((w) => w.collectionId === V2_GROUPS_ID || w.collectionId === V2_MEETINGS_ID));
  const b1 = wf.store[V2_MEETINGS_ID].find((m) => m.fieldData['legacy-item-id'] === 'b1');
  const beta = wf.store[V2_GROUPS_ID].find((g) => g.fieldData['legacy-group-key'] === 'g:beta group');
  assert.equal(b1.fieldData.group, beta.id);
  assert.equal(beta.fieldData.slug, 'beta-group-2');
  assert.ok([...wf.store[V2_GROUPS_ID], ...wf.store[V2_MEETINGS_ID]].filter((x) => x.id.startsWith('new-')).every((x) => x.isDraft === true));
  const again = await runSync({ mode: 'dry-run', client: wf, log: silent });
  assert.deepEqual([again.summary.create, again.summary.update, again.summary.retire],
    [{ groups: 0, meetings: 0 }, { groups: 0, meetings: 0 }, { groups: 0, meetings: 0 }]);
});
await checkAsync('dry-run writes nothing', async () => {
  const { v1, groups, meetings } = synthetic();
  const wf = fakeWebflow(v1, groups, meetings, dayOptions);
  await runSync({ mode: 'dry-run', client: wf, log: silent });
  assert.equal(wf.writes.length, 0);
});
await checkAsync('verify catches a write that did not stick', async () => {
  const { v1, groups, meetings } = synthetic();
  const wf = fakeWebflow(v1, groups, meetings, dayOptions);
  const realWrite = wf.write;
  wf.write = async (method, id, path, body) => (method === 'PATCH' && id === V2_GROUPS_ID ? { items: [] } : realWrite(method, id, path, body));
  const { ok, summary } = await runSync({ mode: 'apply', client: wf, log: silent });
  assert.equal(ok, false);
  assert.ok(summary.errors >= 3, `${summary.errors} errors`); // collision + unpatched update + unretired group
});
await checkAsync('mass retirement is refused before any write', async () => {
  const { v1, groups, meetings } = synthetic();
  const extra = Array.from({ length: 25 }, (_, i) =>
    asStored(MEETING_FIELDS, { name: 'x', slug: `vanished-${i}`, 'legacy-item-id': `vanished-${i}` }, `M-v${i}`));
  const wf = fakeWebflow(v1, groups, [...meetings, ...extra], dayOptions);
  const { ok } = await runSync({ mode: 'apply', client: wf, log: silent });
  assert.equal(ok, false);
  assert.equal(wf.writes.length, 0);
});

// ── (e) Real data: the sample already in v2 survives a first run ────────────
console.log('(e) first run over the real backup leaves the v2 sample untouched');
const SAMPLE = ['sample-groups-payload.json', 'sample-meetings-payload.json', 'sample-meetings-planned.json'].map((f) => `${PY_OUT}/${f}`);
if ([BACKUP, ...SAMPLE].every(existsSync)) {
  const v1 = readJson(BACKUP);
  const [sg, sm, sp] = SAMPLE.map(readJson);
  // The payloads were the sample import's request bodies; rebuild what
  // Webflow holds from them (group IDs from the meetings' references).
  const groupIdByKey = new Map();
  const dayIdByName = new Map();
  for (const m of sm) {
    const planned = sp.find((x) => x.fieldData['legacy-item-id'] === m.fieldData['legacy-item-id']);
    groupIdByKey.set(planned.groupKey, m.fieldData.group);
    dayIdByName.set(planned.fieldData.day, m.fieldData.day);
  }
  const days = DAYS.map((name, i) => ({ id: dayIdByName.get(name) ?? `fake-day-${i}`, name }));
  const groups = sg.map((g) => asStored(GROUP_FIELDS, g.fieldData, groupIdByKey.get(g.fieldData['legacy-group-key'])));
  const meetings = sm.map((m, i) => asStored(MEETING_FIELDS, m.fieldData, `sample-m-${i}`));
  check('sample rebuilt: 3 groups with IDs, 8 meetings', () => {
    assert.equal(groups.length, 3);
    assert.ok(groups.every((g) => g.id));
    assert.equal(meetings.length, 8);
  });
  const plan = planSync({ v1Items: v1, v2Groups: groups, v2Meetings: meetings, dayOptions: days });
  check(`plan: 0 updates/retirements/errors; creates ${plan.groups.create.length} groups + ${plan.meetings.create.length} meetings`, () => {
    assert.equal(plan.groups.update.length, 0, `group updates on fields: ${plan.groups.update.flatMap((u) => u.fields).join(', ')}`);
    assert.equal(plan.meetings.update.length, 0, `meeting updates on fields: ${plan.meetings.update.flatMap((u) => u.fields).join(', ')}`);
    assert.equal(plan.groups.retire.length + plan.meetings.retire.length, 0);
    assert.equal(plan.errors.length, 0, `${plan.errors.length} errors`);
    assert.equal(plan.humanItems.length, 0);
    assert.equal(plan.groups.unchanged, 3);
    assert.equal(plan.meetings.unchanged, 8);
    assert.equal(plan.groups.create.length, plan.derived.groups.length - 3);
    assert.equal(plan.meetings.create.length, plan.derived.meetings.length - 8);
  });
  await checkAsync('in-memory apply over the real backup verifies, and a second run is a no-op', async () => {
    const wf = fakeWebflow(v1, groups, meetings, days);
    const sampleBefore = JSON.stringify([...wf.store[V2_GROUPS_ID], ...wf.store[V2_MEETINGS_ID]]);
    const { ok, summary } = await runSync({ mode: 'apply', client: wf, log: silent });
    assert.ok(ok, `${summary.errors} errors`);
    assert.equal(JSON.stringify([...wf.store[V2_GROUPS_ID].slice(0, 3), ...wf.store[V2_MEETINGS_ID].slice(0, 8)]), sampleBefore);
    assert.ok(wf.writes.every((w) => w.count <= 100));
    assert.ok(wf.v1Untouched());
    const again = await runSync({ mode: 'dry-run', client: wf, log: silent });
    assert.ok(again.ok);
    assert.deepEqual([again.summary.create, again.summary.update, again.summary.retire],
      [{ groups: 0, meetings: 0 }, { groups: 0, meetings: 0 }, { groups: 0, meetings: 0 }]);
  });
} else console.log('  skip (private sample payloads not present)');

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
