// Hourly parallel-run sync: re-derives the v2 Groups + Group Meetings
// collections from the v1 Meetings collection and makes v2 match.
//
// Why this exists: the meeting finder is moving from one flat collection
// (every meeting repeats its group's details) to Groups + Group Meetings.
// Until cutover v1 stays the source of truth — volunteers keep editing it and
// the public /meetings feed reads it live — so v2 is rebuilt from v1 every
// hour, and the cutover can happen on any day with v2 already current.
//
// Derivation: scripts/lib/meetings-v2-derive.mjs (exact port of the Python
// reference migrate_v1_to_v2.py). Planning: scripts/lib/meetings-v2-plan.mjs
// (matching, diffing, slug and retirement rules). This file is only I/O.
//
// Safety rules (people use this list to find an AA meeting):
//   • v1 is read, never written. Its collection ID is only ever passed to the
//     paginated GET reader; scripts/test-meetings-v2-derive.mjs fails the
//     build if that stops being true.
//   • Every write goes through write(), which refuses anything but POST/PATCH
//     to the two v2 collections' bulk items endpoint — no /live, no /publish,
//     no DELETE, no isDraft:false, no isArchived. Created items are drafts;
//     retirement is a hide flag, never a delete.
//   • mode comes from sync-meetings-v2.config.json (committed as "dry-run"),
//     overridable by SYNC_MODE. dry-run prints the plan and writes nothing.
//   • An incomplete read (page count short of pagination.total) aborts the
//     run, and more than MAX_RETIREMENTS_PER_RUN retirements refuses to apply:
//     a truncated v1 read must never hide the meeting list.
//   • After an apply, v2 is re-read and re-planned; anything left to do, or
//     any planned item that is not a draft, fails the run.
//   • The repo and its Actions logs are public: output is counts, slugs,
//     group keys and field names. Never field values (contacts, notes).
//
// Env: WEBFLOW_WRITE_TOKEN (CMS read + write), optional SYNC_MODE
//      (dry-run | apply).

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { planSync, verifyPlan } from './lib/meetings-v2-plan.mjs';

const V1_COLLECTION_ID = '6a101256165031ecf1106518'; // Meetings — GET only
export const V2_GROUPS_ID = '6af5eb2a3787a4d79902fc64';
export const V2_MEETINGS_ID = '6af5eb5d981a96b100d3c8cc';
const API = 'https://api.webflow.com/v2';
const MODES = ['dry-run', 'apply'];
const BATCH = 100; // Webflow's bulk create/update limit
const WRITE_GAP_MS = 2000;
// v1 has ~400 meetings and loses a handful a month. More than this in one
// run means a bad read or a mass edit, and either deserves a human first;
// raise it in a reviewed commit if a real clean-up needs more.
const MAX_RETIREMENTS_PER_RUN = 20;

const WRITABLE = new Set([V2_GROUPS_ID, V2_MEETINGS_ID]);

// The single gate for every write. Pure, so the test can prove it refuses
// without any network.
export function assertWriteAllowed(method, collectionId, path, body) {
  if (typeof collectionId !== 'string' || !WRITABLE.has(collectionId)) {
    throw new Error('write refused: not one of the two v2 collections');
  }
  if (method !== 'POST' && method !== 'PATCH') throw new Error(`write refused: method ${method} is not allowed`);
  if (typeof path !== 'string' || path.includes('/live') || path.includes('/publish')) {
    throw new Error('write refused: live/publish endpoints are never used');
  }
  if (path !== `/collections/${collectionId}/items`) throw new Error('write refused: only the bulk items endpoint is used');
  const items = body?.items;
  if (!Array.isArray(items) || items.length === 0 || items.length > BATCH) {
    throw new Error(`write refused: body must carry 1–${BATCH} items`);
  }
  for (const item of items) {
    if (!item || typeof item.fieldData !== 'object' || item.fieldData === null) throw new Error('write refused: item without fieldData');
    const keys = Object.keys(item);
    if (method === 'POST') {
      if (item.isDraft !== true || item.isArchived !== false || keys.some((k) => !['fieldData', 'isDraft', 'isArchived'].includes(k))) {
        throw new Error('write refused: a created item must be a non-archived draft');
      }
    } else if (typeof item.id !== 'string' || keys.some((k) => !['id', 'fieldData'].includes(k))) {
      // An update never carries isDraft/isArchived: publish state is a human's call.
      throw new Error('write refused: an update carries only id and fieldData');
    }
  }
}

let token = null;
let lastWriteAt = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Webflow error bodies can echo submitted values; only the code and the
// offending field names are safe to put in a public log.
async function errorSummary(res) {
  try {
    const body = await res.json();
    const code = typeof body?.code === 'string' ? ` ${body.code}` : '';
    const params = (Array.isArray(body?.details) ? body.details : [])
      .map((d) => d?.param)
      .filter((p) => typeof p === 'string' && /^[\w.\-[\]]+$/.test(p));
    return `${code}${params.length ? ` (fields: ${params.join(', ')})` : ''}`;
  } catch {
    return '';
  }
}

async function request(method, path, body, attempt = 0) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'accept-version': '1.0.0',
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  // A 429 was not processed, so even a POST is safe to resend. Timeouts and
  // 5xx are not retried: a write that may have landed must not be doubled,
  // and the next hourly run picks up whatever is left.
  if (res.status === 429 && attempt < 3) {
    const wait = Math.min(Number(res.headers.get('Retry-After') || 60), 120) * 1000;
    console.log(`429 rate limited — waiting ${wait / 1000}s`);
    await sleep(wait);
    return request(method, path, body, attempt + 1);
  }
  if (!res.ok) throw new Error(`${method} ${path.split('?')[0]} → ${res.status}${await errorSummary(res)}`);
  return res.json();
}

function get(path) {
  return request('GET', path);
}

export async function write(method, collectionId, path, body) {
  assertWriteAllowed(method, collectionId, path, body);
  const wait = lastWriteAt + WRITE_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  try {
    return await request(method, path, body);
  } finally {
    lastWriteAt = Date.now();
  }
}

async function readAllItems(collectionId) {
  const items = [];
  let total = 0;
  for (let offset = 0; ; offset += 100) {
    const page = await get(`/collections/${collectionId}/items?limit=100&offset=${offset}`);
    if (!Array.isArray(page?.items) || !Number.isInteger(page?.pagination?.total)) {
      throw new Error(`unexpected list response for collection ${collectionId}`);
    }
    total = page.pagination.total;
    items.push(...page.items);
    if (items.length >= total) break;
    if (page.items.length === 0) throw new Error(`incomplete read of collection ${collectionId}: ${items.length}/${total}`);
  }
  const ids = new Set(items.map((i) => i?.id));
  if (items.length !== total || ids.size !== items.length) {
    throw new Error(`inconsistent read of collection ${collectionId}: ${items.length} items, ${ids.size} ids, total ${total}`);
  }
  for (const item of items) {
    if (typeof item.id !== 'string' || typeof item.fieldData !== 'object' || item.fieldData === null) {
      throw new Error(`malformed item in collection ${collectionId}`);
    }
  }
  return items;
}

async function readDayOptions(collectionId) {
  const collection = await get(`/collections/${collectionId}`);
  const options = collection?.fields?.find((f) => f?.slug === 'day')?.validations?.options;
  if (!Array.isArray(options) || !options.length || !options.every((o) => typeof o?.id === 'string' && typeof o?.name === 'string')) {
    throw new Error('Group Meetings has no readable `day` option field');
  }
  return options.map((o) => ({ id: o.id, name: o.name }));
}

const chunks = (list) => Array.from({ length: Math.ceil(list.length / BATCH) }, (_, i) => list.slice(i * BATCH, (i + 1) * BATCH));

function printPlan(plan, v1Count, log) {
  const { groups: G, meetings: M } = plan;
  log(`v1: ${v1Count} items → derived ${plan.derived.groups.length} groups, ${plan.derived.meetings.length} meetings (${plan.derived.conflicts.length} in-group disagreements resolved by vote)`);
  log(`groups:   create ${G.create.length}, update ${G.update.length}, retire ${G.retire.length}, unchanged ${G.unchanged}`);
  log(`meetings: create ${M.create.length}, update ${M.update.length}, retire ${M.retire.length}, unchanged ${M.unchanged}`);
  for (const c of G.create) log(`  + group ${c.slug} [${c.key}]`);
  for (const u of G.update) log(`  ~ group ${u.slug}: ${u.fields.join(', ')}`);
  for (const r of G.retire) log(`  - group ${r.slug} [${r.key}] → hidden`);
  for (const c of M.create) log(`  + meeting ${c.slug} → group [${c.groupKey}]`);
  for (const u of M.update) log(`  ~ meeting ${u.slug}: ${u.fields.join(', ')}`);
  for (const r of M.retire) log(`  - meeting ${r.slug} → hidden`);
  for (const h of plan.humanItems) log(`WARN human-made ${h.collection} item ${h.slug} has no legacy key — never touched`);
  for (const w of plan.warnings) log(`WARN ${w}`);
  for (const e of plan.errors) log(`ERROR ${e}`);
}

function mergeById(fresh, created) {
  const ids = new Set(fresh.map((i) => i.id));
  return [...fresh, ...created.filter((i) => i && typeof i.id === 'string' && !ids.has(i.id))];
}

// client: { readAllItems, readDayOptions, write } — injected so the whole
// apply path runs against an in-memory fake in the test.
export async function runSync({ mode, client, log = console.log }) {
  if (!MODES.includes(mode)) throw new Error(`unknown mode ${mode}`);
  const v1Items = await client.readAllItems(V1_COLLECTION_ID);
  let v2Groups = await client.readAllItems(V2_GROUPS_ID);
  let v2Meetings = await client.readAllItems(V2_MEETINGS_ID);
  const dayOptions = await client.readDayOptions(V2_MEETINGS_ID);

  const plan = planSync({ v1Items, v2Groups, v2Meetings, dayOptions });
  log(`Mode: ${mode}`);
  printPlan(plan, v1Items.length, log);

  const errors = [...plan.errors];
  const summary = () => ({
    mode,
    v1Items: v1Items.length,
    plannedGroups: plan.derived.groups.length,
    plannedMeetings: plan.derived.meetings.length,
    create: { groups: plan.groups.create.length, meetings: plan.meetings.create.length },
    update: { groups: plan.groups.update.length, meetings: plan.meetings.update.length },
    retire: { groups: plan.groups.retire.length, meetings: plan.meetings.retire.length },
    humanItems: plan.humanItems.length,
    errors: errors.length,
  });
  if (mode === 'dry-run') return { summary: summary(), ok: errors.length === 0 };

  const retirements = plan.groups.retire.length + plan.meetings.retire.length;
  if (retirements > MAX_RETIREMENTS_PER_RUN) {
    errors.push(`refusing to apply: ${retirements} retirements exceeds ${MAX_RETIREMENTS_PER_RUN}`);
    log(`ERROR ${errors.at(-1)}`);
    return { summary: summary(), ok: false };
  }

  const fail = (msg, skippedSet, key) => {
    errors.push(msg);
    log(`ERROR ${msg}`);
    if (skippedSet) skippedSet.add(key);
  };

  // 1. Groups first: new meetings need their group's item ID.
  const created = [];
  for (const batch of chunks(plan.groups.create)) {
    const res = await client.write('POST', V2_GROUPS_ID, `/collections/${V2_GROUPS_ID}/items`, {
      items: batch.map((c) => ({ fieldData: c.fieldData, isDraft: true, isArchived: false })),
    });
    created.push(...(Array.isArray(res?.items) ? res.items : res?.id ? [res] : []));
  }
  if (plan.groups.create.length) log(`created ${plan.groups.create.length} groups`);
  // The create response is merged in case the list endpoint lags; a group
  // still missing after that is reported, never created twice.
  v2Groups = mergeById(await client.readAllItems(V2_GROUPS_ID), created);
  const plan2 = planSync({ v1Items, v2Groups, v2Meetings, dayOptions });
  const skipped = plan2.skipped;
  for (const e of plan2.errors) if (!errors.includes(e)) fail(e);
  for (const c of plan2.groups.create) fail(`group ${c.slug} [${c.key}] missing after create`, skipped.groups, c.key);

  // 2. Group updates and retirements share the PATCH endpoint.
  const groupPatches = [...plan2.groups.update, ...plan2.groups.retire];
  for (const batch of chunks(groupPatches)) {
    await client.write('PATCH', V2_GROUPS_ID, `/collections/${V2_GROUPS_ID}/items`, {
      items: batch.map((u) => ({ id: u.id, fieldData: u.fieldData })),
    });
  }
  if (groupPatches.length) log(`patched ${groupPatches.length} groups`);

  // 3. Meetings. A meeting whose group still has no ID would be written with
  //    no group, i.e. orphaned — skip it instead.
  const meetingCreates = plan2.meetings.create.filter((c) => {
    if (!c.pendingGroup) return true;
    fail(`meeting ${c.slug}: group [${c.pendingGroup}] has no v2 item; not created`, skipped.meetings, c.key);
    return false;
  });
  for (const batch of chunks(meetingCreates)) {
    await client.write('POST', V2_MEETINGS_ID, `/collections/${V2_MEETINGS_ID}/items`, {
      items: batch.map((c) => ({ fieldData: c.fieldData, isDraft: true, isArchived: false })),
    });
  }
  if (meetingCreates.length) log(`created ${meetingCreates.length} meetings`);
  const meetingPatches = [
    ...plan2.meetings.update.filter((u) => {
      if (!u.pendingGroup) return true;
      fail(`meeting ${u.slug}: group [${u.pendingGroup}] has no v2 item; not updated`, skipped.meetings, u.key);
      return false;
    }),
    ...plan2.meetings.retire,
  ];
  for (const batch of chunks(meetingPatches)) {
    await client.write('PATCH', V2_MEETINGS_ID, `/collections/${V2_MEETINGS_ID}/items`, {
      items: batch.map((u) => ({ id: u.id, fieldData: u.fieldData })),
    });
  }
  if (meetingPatches.length) log(`patched ${meetingPatches.length} meetings`);

  // 4. Verify against a fresh read.
  v2Groups = await client.readAllItems(V2_GROUPS_ID);
  v2Meetings = await client.readAllItems(V2_MEETINGS_ID);
  const after = planSync({ v1Items, v2Groups, v2Meetings, dayOptions });
  const executed = { skipped, errors, groups: { create: plan.groups.create }, meetings: { create: meetingCreates } };
  const mismatches = verifyPlan(executed, after, v2Groups, v2Meetings);
  for (const mm of mismatches) fail(`verify: ${mm}`);
  log(mismatches.length ? `verify FAILED: ${mismatches.length} mismatches` : 'verify OK: v2 matches the plan, all planned items are drafts');
  return { summary: summary(), ok: errors.length === 0 };
}

export function resolveMode(env = process.env) {
  const config = JSON.parse(readFileSync(new URL('./sync-meetings-v2.config.json', import.meta.url), 'utf8'));
  const mode = (env.SYNC_MODE || '').trim() || config.mode;
  if (!MODES.includes(mode)) throw new Error(`mode must be one of ${MODES.join(', ')}`);
  return mode;
}

async function main() {
  token = process.env.WEBFLOW_WRITE_TOKEN;
  if (!token) {
    console.error(
      'WEBFLOW_WRITE_TOKEN is not set. Add a Webflow site token with CMS read+write ' +
        'for the AA Manitoba site as a GitHub Actions secret named WEBFLOW_WRITE_TOKEN.'
    );
    process.exit(1);
  }
  const mode = resolveMode();
  const { summary, ok } = await runSync({ mode, client: { readAllItems, readDayOptions, write } });
  console.log(JSON.stringify(summary));
  process.exitCode = ok ? 0 : 1;
}

// Imported by the test for its exports; only a direct run talks to Webflow.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    // Our own messages carry only paths, status codes and field names.
    console.error(`FATAL ${err.message}`);
    process.exit(1);
  });
}
