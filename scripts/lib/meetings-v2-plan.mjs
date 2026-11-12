// Pure planner for the v1 → v2 meetings sync. No I/O: it takes what was read
// from Webflow and returns what to write, so every rule below is testable
// in memory (scripts/test-meetings-v2-derive.mjs) before it touches the CMS.
//
// Rules, and why:
//   • v2 items are matched to the derivation by legacy key only
//     (legacy-group-key / legacy-item-id). Items with neither key were made by
//     a human in the CMS: they are reported (slug only) and never written.
//   • Only managed fields that actually differ are PATCHed, so an unchanged
//     item costs no write and the hourly run is a no-op once v2 has caught up.
//     "Differ" treats null, '' and a missing key as the same empty value
//     (Webflow returns unset fields as explicit null), and a switch that is
//     null as off.
//   • Slugs are set only at creation. A meeting slug is a public link (TSML
//     and CMS URLs), so a taken meeting slug is an error, never a rename; a
//     group slug is internal, so a taken one gets -2, -3….
//   • A v2 item whose key is no longer derived (v1 meeting archived or
//     deleted) is retired with hide-from-meeting-finder=true, never deleted:
//     retirement is reversible, deletion is not.
//   • A duplicated legacy key in v2 makes that key ambiguous; it is reported
//     and nothing under it is written until a human resolves it.
//
// Messages carry only slugs, group keys and field names: the job's logs are
// public, and field values include contact names, emails and phones. A
// standalone group's key ('s:<name>|<address>') embeds an address, so it is
// only ever logged through logKey().

import { createHash } from 'node:crypto';
import { migrate, slugify } from './meetings-v2-derive.mjs';

export const GROUP_FIELDS = [
  'name', 'slug', 'location', 'address', 'region', 'sub-region', 'location-notes', 'latitude', 'longitude',
  'geocoded-address', 'approximate', 'timezone', 'conference-url', 'conference-url-notes', 'group-notes',
  'website', 'email', 'phone', 'mailing-address', 'contact-1-name', 'contact-1-email', 'contact-1-phone',
  'contact-2-name', 'contact-2-email', 'contact-2-phone', 'contact-3-name', 'contact-3-email', 'contact-3-phone',
  'hide-from-meeting-finder', 'hide-group-name', 'legacy-group-key',
];
export const MEETING_FIELDS = [
  'name', 'slug', 'group', 'day', 'start-time', 'end-time', 'types', 'notes', 'display-name',
  'conference-url-override', 'conference-url-notes-override', 'no-online-option', 'starts-on', 'ends-on',
  'hide-from-meeting-finder', 'legacy-item-id', 'legacy-author',
];
const SWITCHES = new Set(['hide-from-meeting-finder', 'hide-group-name', 'no-online-option']);
const HIDE = 'hide-from-meeting-finder';

const empty = (v) => v === undefined || v === null || v === '';

// 'g:' keys are public group names and stay readable; 's:' keys carry an
// address, so logs get a short stable hash that still matches across runs.
export function logKey(key) {
  if (typeof key === 'string' && key.startsWith('s:')) {
    return `s:#${createHash('sha256').update(key).digest('hex').slice(0, 8)}`;
  }
  return String(key);
}

export function sameValue(field, a, b) {
  if (SWITCHES.has(field)) {
    const off = (v) => (empty(v) ? false : v);
    return off(a) === off(b);
  }
  if (empty(a) && empty(b)) return true;
  if (empty(a) || empty(b)) return false;
  if (typeof a !== 'object' && typeof b !== 'object') return a === b;
  return canonical(a) === canonical(b);
}

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

function changedFields(fields, current, target) {
  return fields.filter((f) => f !== 'slug' && !sameValue(f, current[f], target[f]));
}

// Webflow creates were verified with unset fields omitted (the sample
// import); an omitted field reads back as null, the same as the plan.
function withoutEmpty(fd) {
  return Object.fromEntries(Object.entries(fd).filter(([, v]) => !empty(v)));
}

function indexByKey(items, keyField, collection, errors, humanItems) {
  const byKey = new Map();
  for (const item of items) {
    const key = item.fieldData?.[keyField];
    if (empty(key)) {
      humanItems.push({ collection, slug: item.fieldData?.slug ?? `(no slug, id ${item.id})` });
      continue;
    }
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(item);
  }
  const blocked = new Set();
  for (const [key, list] of byKey) {
    if (list.length > 1) {
      blocked.add(key);
      errors.push(`${collection}: ${list.length} v2 items share ${keyField} ${logKey(key)} (slugs ${list.map((i) => i.fieldData?.slug).join(', ')}); nothing under this key is written until one is removed`);
    }
  }
  return { byKey, blocked };
}

// dayOptions: [{ id, name }] from the Group Meetings collection's `day` field.
export function planSync({ v1Items, v2Groups, v2Meetings, dayOptions }) {
  const derived = migrate(v1Items);
  const errors = [];
  const warnings = [];
  const humanItems = [];
  // Keys that this plan deliberately leaves alone; verification skips them.
  const skipped = { groups: new Set(), meetings: new Set() };

  const g = indexByKey(v2Groups, 'legacy-group-key', 'groups', errors, humanItems);
  const m = indexByKey(v2Meetings, 'legacy-item-id', 'meetings', errors, humanItems);
  for (const k of g.blocked) skipped.groups.add(k);
  for (const k of m.blocked) skipped.meetings.add(k);

  const groups = { create: [], update: [], retire: [], unchanged: 0 };
  const meetings = { create: [], update: [], retire: [], unchanged: 0 };

  // ── Groups ────────────────────────────────────────────────────────────────
  const takenGroupSlugs = new Set(v2Groups.map((i) => i.fieldData?.slug).filter(Boolean));
  const newGroups = derived.groups.filter((dg) => !g.byKey.has(dg.key));
  // A suffixed slug must not steal the plain slug another new group is about
  // to claim, or that group would be suffixed for no reason.
  const reservedGroupSlugs = new Set(newGroups.map((dg) => dg.fieldData.slug));
  const groupIdByKey = new Map();
  const pendingGroupKeys = new Set();

  for (const dg of derived.groups) {
    if (g.blocked.has(dg.key)) continue;
    const existing = g.byKey.get(dg.key)?.[0];
    if (!existing) {
      let slug = dg.fieldData.slug;
      if (takenGroupSlugs.has(slug)) {
        const base = slugify(dg.fieldData.name);
        let n = 2;
        while (takenGroupSlugs.has(`${base}-${n}`) || reservedGroupSlugs.has(`${base}-${n}`)) n++;
        warnings.push(`group ${logKey(dg.key)}: slug ${slug} is taken in v2, creating as ${base}-${n}`);
        slug = `${base}-${n}`;
      }
      takenGroupSlugs.add(slug);
      groups.create.push({ key: dg.key, slug, fieldData: withoutEmpty({ ...dg.fieldData, slug }) });
      pendingGroupKeys.add(dg.key);
      continue;
    }
    groupIdByKey.set(dg.key, existing.id);
    const fields = changedFields(GROUP_FIELDS, existing.fieldData, dg.fieldData);
    if (fields.length) {
      groups.update.push({
        id: existing.id, key: dg.key, slug: existing.fieldData.slug, fields,
        fieldData: Object.fromEntries(fields.map((f) => [f, empty(dg.fieldData[f]) ? null : dg.fieldData[f]])),
      });
    } else groups.unchanged++;
  }
  const derivedGroupKeys = new Set(derived.groups.map((dg) => dg.key));
  for (const [key, list] of g.byKey) {
    if (derivedGroupKeys.has(key) || g.blocked.has(key)) continue;
    if (list[0].fieldData[HIDE] !== true) {
      groups.retire.push({ id: list[0].id, key, slug: list[0].fieldData.slug, fieldData: { [HIDE]: true } });
    }
  }

  // ── Meetings ──────────────────────────────────────────────────────────────
  const dayIdByName = new Map(dayOptions.map((o) => [o.name, o.id]));
  const meetingSlugOwner = new Map();
  for (const item of v2Meetings) {
    if (item.fieldData?.slug) meetingSlugOwner.set(item.fieldData.slug, item.fieldData['legacy-item-id'] ?? null);
  }

  for (const dm of derived.meetings) {
    const key = dm.legacyId;
    const slug = dm.fieldData.slug;
    if (m.blocked.has(key)) continue;
    const skip = (why) => {
      errors.push(`meeting ${slug}: ${why}`);
      skipped.meetings.add(key);
    };
    if (g.blocked.has(dm.groupKey)) {
      skip(`its group ${logKey(dm.groupKey)} is ambiguous in v2; not written`);
      continue;
    }
    const dayId = dayIdByName.get(dm.fieldData.day);
    if (!dayId) {
      skip('its day has no matching option on the v2 day field; not written');
      continue;
    }
    const pendingGroup = pendingGroupKeys.has(dm.groupKey) ? dm.groupKey : null;
    // A group created in this run has no ID yet; the job re-plans after
    // creating groups, and refuses to write a meeting still pending.
    const target = { ...dm.fieldData, group: pendingGroup ? null : groupIdByKey.get(dm.groupKey), day: dayId };

    const existing = m.byKey.get(key)?.[0];
    if (!existing) {
      if (empty(slug)) {
        skip('v1 item has no slug; not created');
        continue;
      }
      // Left as an error on purpose: renaming would break a public link. To
      // resolve by hand, either clear (or change) the slug on the v2 item
      // that holds it — typically a retired meeting — so the next run can
      // create this one, or, if this is the same meeting re-entered in v1,
      // set that v2 item's legacy-item-id to the new v1 item ID so the sync
      // adopts it instead of creating a second one.
      if (meetingSlugOwner.has(slug)) {
        skip('slug is already used by another v2 item; not created (meeting slugs are public links and are never renamed)');
        continue;
      }
      meetingSlugOwner.set(slug, key);
      meetings.create.push({ key, slug, groupKey: dm.groupKey, pendingGroup, fieldData: withoutEmpty(target) });
      continue;
    }
    if (existing.fieldData.slug !== slug) {
      warnings.push(`meeting ${existing.fieldData.slug}: v1 slug is now ${slug}; v2 slug left unchanged`);
    }
    const fields = changedFields(MEETING_FIELDS, existing.fieldData, target);
    if (pendingGroup && !fields.includes('group')) fields.push('group');
    if (fields.length) {
      meetings.update.push({
        id: existing.id, key, slug: existing.fieldData.slug, groupKey: dm.groupKey, pendingGroup, fields,
        fieldData: Object.fromEntries(fields.map((f) => [f, empty(target[f]) ? null : target[f]])),
      });
    } else meetings.unchanged++;
  }
  const derivedMeetingKeys = new Set(derived.meetings.map((dm) => dm.legacyId));
  for (const [key, list] of m.byKey) {
    if (derivedMeetingKeys.has(key) || m.blocked.has(key)) continue;
    if (list[0].fieldData[HIDE] !== true) {
      meetings.retire.push({ id: list[0].id, key, slug: list[0].fieldData.slug, fieldData: { [HIDE]: true } });
    }
  }

  return { derived, groups, meetings, humanItems, errors, warnings, skipped };
}

// A group is only hidden once no visible v2 meeting points at it: hiding a
// group that a live meeting still references would orphan that meeting in
// the feed. Returns the retirements that are safe now and the ones to leave
// for a later run.
export function splitGroupRetirements(retire, v2Meetings) {
  const referenced = new Set(
    v2Meetings.filter((m) => m.fieldData?.[HIDE] !== true).map((m) => m.fieldData?.group).filter(Boolean)
  );
  return { retire: retire.filter((r) => !referenced.has(r.id)), kept: retire.filter((r) => referenced.has(r.id)) };
}

// After an apply, a fresh plan over the re-read v2 state must be empty and
// every planned item must still be a draft. `before` is what was executed:
// { skipped, errors, groups: { create }, meetings: { create } }. Returns
// mismatch messages (slugs, keys and field names only).
export function verifyPlan(before, after, v2Groups, v2Meetings) {
  const out = [];
  for (const [kind, plan] of [['groups', after.groups], ['meetings', after.meetings]]) {
    for (const op of [...plan.create, ...plan.update, ...plan.retire]) {
      if (before.skipped[kind].has(op.key)) continue;
      const what = plan.create.includes(op) ? 'missing' : plan.retire.includes(op) ? 'not retired' : `differs in [${op.fields.join(', ')}]`;
      out.push(`${kind} ${op.slug ?? logKey(op.key)}: ${what}`);
    }
  }
  const knownErrors = new Set(before.errors);
  for (const e of after.errors) if (!knownErrors.has(e)) out.push(`new error after apply: ${e}`);

  const derivedGroupKeys = new Set(after.derived.groups.map((x) => x.key));
  for (const item of v2Groups) {
    const key = item.fieldData?.['legacy-group-key'];
    if (derivedGroupKeys.has(key) && !before.skipped.groups.has(key) && item.isDraft !== true) {
      out.push(`groups ${item.fieldData.slug}: isDraft is not true`);
    }
  }
  const derivedMeetingKeys = new Set(after.derived.meetings.map((x) => x.legacyId));
  for (const item of v2Meetings) {
    const key = item.fieldData?.['legacy-item-id'];
    if (derivedMeetingKeys.has(key) && !before.skipped.meetings.has(key) && item.isDraft !== true) {
      out.push(`meetings ${item.fieldData.slug}: isDraft is not true`);
    }
  }
  // Slugs are never diffed for existing items, so a create's slug is checked
  // directly against what was sent.
  const sent = new Map(before.groups.create.map((c) => [c.key, c.slug]));
  for (const item of v2Groups) {
    const want = sent.get(item.fieldData?.['legacy-group-key']);
    if (want && item.fieldData.slug !== want) out.push(`groups ${want}: created with a different slug`);
  }
  const sentMeetings = new Map(before.meetings.create.map((c) => [c.key, c.slug]));
  for (const item of v2Meetings) {
    const want = sentMeetings.get(item.fieldData?.['legacy-item-id']);
    if (want && item.fieldData.slug !== want) out.push(`meetings ${want}: created with a different slug`);
  }
  return out;
}
