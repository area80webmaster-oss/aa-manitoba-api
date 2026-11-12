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
//     no DELETE, no isArchived. Created and updated items both say
//     isDraft:true explicitly, so the parallel run never depends on an API
//     default to stay unpublished. Retirement is a hide flag, never a delete.
//   • mode comes from sync-meetings-v2.config.json, overridable by SYNC_MODE.
//     dry-run prints the plan and writes nothing.
//   • A read that comes up short of pagination.total, or whose total moved
//     while paging, aborts the run. More than MAX_RETIREMENTS_PER_RUN
//     retirements, or more than MAX_CREATES_PER_RUN creates once v2 is
//     populated, refuses to apply: a bad read must never hide or duplicate the
//     meeting list.
//   • Write order is group creates → meeting creates/updates → group updates
//     → meeting retirements → group retirements, so a meeting is never left
//     pointing at a hidden group; a group still referenced by a visible
//     meeting is not retired.
//   • A failing batch never stops the run: a 4xx batch is retried item by
//     item to isolate the bad one; a timeout or 5xx may have landed, so it is
//     recorded and left for the next run. Any failure exits non-zero.
//   • After an apply, v2 is re-read and re-planned; anything left to do, or
//     any planned item that is not a draft, fails the run.
//   • The repo and its Actions logs are public: output is counts, slugs,
//     'g:' group keys (public names) and field names. Standalone 's:' keys
//     embed an address and are logged as a hash. Never field values.
//
// Env: WEBFLOW_WRITE_TOKEN (CMS read + write), optional SYNC_MODE
//      (dry-run | apply).

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { logKey, planSync, splitGroupRetirements, verifyPlan } from './lib/meetings-v2-plan.mjs';

const V1_COLLECTION_ID = '6a101256165031ecf1106518'; // Meetings — GET only
export const V2_GROUPS_ID = '6af5eb2a3787a4d79902fc64';
export const V2_MEETINGS_ID = '6af5eb5d981a96b100d3c8cc';
const API = 'https://api.webflow.com/v2';
const MODES = ['dry-run', 'apply'];
const BATCH = 100; // Webflow's bulk create/update limit
const WRITE_GAP_MS = 2000;
const MAX_429_RETRIES = 3;
const DEFAULT_RETRY_SECONDS = 2;
const MAX_RETRY_SECONDS = 60;
// v1 has ~400 meetings and loses a handful a month. More than this in one
// run means a bad read or a mass edit, and either deserves a human first;
// raise it in a reviewed commit if a real clean-up needs more.
const MAX_RETIREMENTS_PER_RUN = 20;
// The first import is done; a normal hour creates a few items at most. A
// burst means the legacy keys stopped matching (renamed field, bad read) and
// the run would duplicate the list. Only enforced once v2 holds keyed items,
// so an empty v2 can still be imported.
const MAX_CREATES_PER_RUN = 50;

const WRITABLE = new Set([V2_GROUPS_ID, V2_MEETINGS_ID]);

class WriteRefused extends Error {
  constructor(message) {
    super(`write refused: ${message}`);
    this.name = 'WriteRefused';
  }
}

// status/code/field names only — never the response body, which can echo
// submitted values.
export class HttpError extends Error {
  constructor(method, path, status, code = '', fields = []) {
    super(`${method} ${path} → ${status}${code ? ` ${code}` : ''}${fields.length ? ` (fields: ${fields.join(', ')})` : ''}`);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

// The single gate for every write. Pure, so the test can prove it refuses
// without any network.
export function assertWriteAllowed(method, collectionId, path, body) {
  if (typeof collectionId !== 'string' || !WRITABLE.has(collectionId)) {
    throw new WriteRefused('not one of the two v2 collections');
  }
  if (method !== 'POST' && method !== 'PATCH') throw new WriteRefused(`method ${method} is not allowed`);
  if (typeof path !== 'string' || path.includes('/live') || path.includes('/publish')) {
    throw new WriteRefused('live/publish endpoints are never used');
  }
  if (path !== `/collections/${collectionId}/items`) throw new WriteRefused('only the bulk items endpoint is used');
  const items = body?.items;
  if (!Array.isArray(items) || items.length === 0 || items.length > BATCH) {
    throw new WriteRefused(`body must carry 1–${BATCH} items`);
  }
  for (const item of items) {
    if (!item || typeof item.fieldData !== 'object' || item.fieldData === null) throw new WriteRefused('item without fieldData');
    const keys = Object.keys(item).sort().join(',');
    if (method === 'POST') {
      if (item.isDraft !== true || item.isArchived !== false || keys !== 'fieldData,isArchived,isDraft') {
        throw new WriteRefused('a created item must be exactly {fieldData, isDraft:true, isArchived:false}');
      }
    } else if (typeof item.id !== 'string' || item.isDraft !== true || keys !== 'fieldData,id,isDraft') {
      throw new WriteRefused('an update must be exactly {id, fieldData, isDraft:true}');
    }
  }
}

// Same rule as src/lib/meetings-v2/webflow.ts: a missing or non-numeric
// header is not a reason to stall the job for a minute.
export function retryAfterMs(raw) {
  const seconds = raw !== null && raw !== undefined && String(raw).trim() !== '' ? Number(raw) : NaN;
  const chosen = Number.isFinite(seconds) && seconds >= 0 ? seconds : DEFAULT_RETRY_SECONDS;
  return Math.min(chosen, MAX_RETRY_SECONDS) * 1000;
}

// A JSON parse error's message quotes the text it choked on — a response
// body — so only its name is safe for a public log.
export function describeError(err) {
  if (err?.name === 'SyntaxError') return 'SyntaxError';
  if (err instanceof HttpError) return `${err.status}${err.code ? ` ${err.code}` : ''}`;
  if (err?.name === 'TimeoutError') return 'TimeoutError';
  return String(err?.message ?? err);
}

let token = null;
let lastWriteAt = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function errorDetails(res) {
  try {
    const body = await res.json();
    const code = typeof body?.code === 'string' && /^[\w.-]+$/.test(body.code) ? body.code : '';
    const fields = (Array.isArray(body?.details) ? body.details : [])
      .map((d) => d?.param)
      .filter((p) => typeof p === 'string' && /^[\w.\-[\]]+$/.test(p));
    return [code, fields];
  } catch {
    return ['', []];
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
  if (res.status === 429 && attempt < MAX_429_RETRIES) {
    const wait = retryAfterMs(res.headers.get('Retry-After'));
    await res.body?.cancel();
    console.log(`429 rate limited — waiting ${wait / 1000}s`);
    await sleep(wait);
    return request(method, path, body, attempt + 1);
  }
  if (!res.ok) throw new HttpError(method, path.split('?')[0], res.status, ...(await errorDetails(res)));
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

// Exported for the test (with fetch stubbed); production reaches it only via
// the client object in main().
export async function readAllItems(collectionId) {
  const items = [];
  let total = 0;
  for (let offset = 0; ; offset += 100) {
    const page = await get(`/collections/${collectionId}/items?limit=100&offset=${offset}`);
    if (!Array.isArray(page?.items) || !Number.isInteger(page?.pagination?.total)) {
      throw new Error(`unexpected list response for collection ${collectionId}`);
    }
    if (offset > 0 && page.pagination.total !== total) {
      throw new Error(`collection ${collectionId} changed while reading (total ${total} → ${page.pagination.total})`);
    }
    total = page.pagination.total;
    items.push(...page.items);
    if (items.length >= total) break;
    if (page.items.length === 0) throw new Error(`incomplete read of collection ${collectionId}: ${items.length}/${total}`);
  }
  // An item added or deleted mid-read shifts later pages by one, so the read
  // can be complete in count yet miss or double an item; a moved total says
  // exactly that, and the next run reads a settled list.
  const after = await get(`/collections/${collectionId}/items?limit=1&offset=0`);
  if (after?.pagination?.total !== total) {
    throw new Error(`collection ${collectionId} changed while reading (total ${total} → ${after?.pagination?.total})`);
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
  for (const c of G.create) log(`  + group ${c.slug} [${logKey(c.key)}]`);
  for (const u of G.update) log(`  ~ group ${u.slug}: ${u.fields.join(', ')}`);
  for (const r of G.retire) log(`  - group ${r.slug} [${logKey(r.key)}] → hidden`);
  for (const c of M.create) log(`  + meeting ${c.slug} → group [${logKey(c.groupKey)}]`);
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

const hasLegacyKey = (item, field) => typeof item.fieldData?.[field] === 'string' && item.fieldData[field] !== '';

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

  const refuse = (msg) => {
    errors.push(`refusing to apply: ${msg}`);
    log(`ERROR ${errors.at(-1)}`);
    return { summary: summary(), ok: false };
  };
  const retirements = plan.groups.retire.length + plan.meetings.retire.length;
  if (retirements > MAX_RETIREMENTS_PER_RUN) return refuse(`${retirements} retirements exceeds ${MAX_RETIREMENTS_PER_RUN}`);
  const creates = plan.groups.create.length + plan.meetings.create.length;
  const populated = v2Groups.some((i) => hasLegacyKey(i, 'legacy-group-key')) || v2Meetings.some((i) => hasLegacyKey(i, 'legacy-item-id'));
  if (populated && creates > MAX_CREATES_PER_RUN) return refuse(`${creates} creates exceeds ${MAX_CREATES_PER_RUN} on a populated v2`);

  const fail = (msg, skippedSet, key) => {
    errors.push(msg);
    log(`ERROR ${msg}`);
    if (skippedSet) skippedSet.add(key);
  };

  // Writes ops in bulk batches. A 4xx means Webflow rejected the request as a
  // whole, usually for one bad item, so the batch is retried item by item to
  // let the good ones through and name the bad one. Anything else (timeout,
  // 5xx, network, exhausted 429) may have been applied, so it is recorded and
  // left for the next run's fresh plan. A guard refusal is a bug: it stops
  // the run.
  async function writeOps(label, method, collectionId, ops, toItem, skippedSet) {
    const path = `/collections/${collectionId}/items`;
    const returned = [];
    let written = 0;
    const collect = (res) => returned.push(...(Array.isArray(res?.items) ? res.items : res?.id ? [res] : []));
    const splittable = (err) => err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 429;
    for (const batch of chunks(ops)) {
      try {
        collect(await client.write(method, collectionId, path, { items: batch.map(toItem) }));
        written += batch.length;
        continue;
      } catch (err) {
        if (err instanceof WriteRefused) throw err;
        if (!splittable(err) || batch.length === 1) {
          for (const op of batch) skippedSet.add(op.key);
          const who = batch.length === 1 ? batch[0].slug : `batch of ${batch.length} (${batch.map((o) => o.slug).join(', ')})`;
          fail(`${label} ${who}: ${method} failed: ${describeError(err)}${splittable(err) ? '' : '; may have landed, left for the next run'}`);
          continue;
        }
        log(`WARN ${label} batch of ${batch.length} rejected (${describeError(err)}); retrying one by one`);
      }
      for (const op of batch) {
        try {
          collect(await client.write(method, collectionId, path, { items: [toItem(op)] }));
          written++;
        } catch (err) {
          if (err instanceof WriteRefused) throw err;
          fail(`${label} ${op.slug}: ${method} failed: ${describeError(err)}`, skippedSet, op.key);
        }
      }
    }
    if (written) log(`${label}: ${written} written`);
    return returned;
  }
  const asCreate = (c) => ({ fieldData: c.fieldData, isDraft: true, isArchived: false });
  const asPatch = (u) => ({ id: u.id, fieldData: u.fieldData, isDraft: true });

  // 1. Group creates first: new meetings need their group's item ID.
  const failedGroupCreates = new Set();
  const created = await writeOps('group create', 'POST', V2_GROUPS_ID, plan.groups.create, asCreate, failedGroupCreates);
  // The create response is merged in case the list endpoint lags; a group
  // still missing after that is reported, never created twice.
  v2Groups = mergeById(await client.readAllItems(V2_GROUPS_ID), created);
  const plan2 = planSync({ v1Items, v2Groups, v2Meetings, dayOptions });
  const skipped = plan2.skipped;
  for (const k of failedGroupCreates) skipped.groups.add(k);
  for (const e of plan2.errors) if (!errors.includes(e)) fail(e);
  for (const c of plan2.groups.create) {
    if (!failedGroupCreates.has(c.key)) fail(`group ${c.slug} [${logKey(c.key)}] missing after create`, skipped.groups, c.key);
  }

  // 2. Meetings. One whose group still has no ID would be written with no
  //    group, i.e. orphaned — skip it; every other meeting still goes.
  const ready = (op, verb) => {
    if (!op.pendingGroup) return true;
    fail(`meeting ${op.slug}: group [${logKey(op.pendingGroup)}] has no v2 item; not ${verb}`, skipped.meetings, op.key);
    return false;
  };
  const meetingCreates = plan2.meetings.create.filter((c) => ready(c, 'created'));
  await writeOps('meeting create', 'POST', V2_MEETINGS_ID, meetingCreates, asCreate, skipped.meetings);
  const meetingUpdates = plan2.meetings.update.filter((u) => ready(u, 'updated'));
  await writeOps('meeting update', 'PATCH', V2_MEETINGS_ID, meetingUpdates, asPatch, skipped.meetings);

  // 3. Group updates.
  await writeOps('group update', 'PATCH', V2_GROUPS_ID, plan2.groups.update, asPatch, skipped.groups);

  // 4. Retirements last, meetings before groups, so nothing visible is ever
  //    left pointing at a hidden group.
  await writeOps('meeting retire', 'PATCH', V2_MEETINGS_ID, plan2.meetings.retire, asPatch, skipped.meetings);
  const { retire: groupRetires, kept } = splitGroupRetirements(plan2.groups.retire, await client.readAllItems(V2_MEETINGS_ID));
  for (const r of kept) {
    log(`WARN group ${r.slug} [${logKey(r.key)}]: still referenced by a visible v2 meeting; not retired this run`);
    skipped.groups.add(r.key);
  }
  await writeOps('group retire', 'PATCH', V2_GROUPS_ID, groupRetires, asPatch, skipped.groups);

  // 5. Verify against a fresh read.
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

export function fatalMessage(err) {
  return `FATAL ${err?.name === 'SyntaxError' ? err.name : err?.message ?? String(err)}`;
}

// Imported by the test for its exports; only a direct run talks to Webflow.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    // Our own messages carry only paths, status codes and field names; a
    // SyntaxError's message would quote a response body.
    console.error(fatalMessage(err));
    process.exit(1);
  });
}
