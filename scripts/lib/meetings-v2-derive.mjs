// Pure derivation of Groups + Group Meetings (v2) records from flat v1
// Meetings items. No I/O: same input, same output, every run.
//
// This is a line-for-line port of migrate() in
// meetings-restructure/tools/migrate_v1_to_v2.py, which is the reference. The
// hourly sync re-derives v2 from v1 with this file, so any drift from the
// Python would show up as spurious updates (or worse, silently different
// groupings). scripts/test-meetings-v2-derive.mjs proves parity on the real
// backup and on edge-case fixtures run through the Python itself.
//
// Python semantics that JavaScript does not share, and how they are kept:
//   • str.strip() and re's \s use Python's whitespace set, which differs from
//     JS's \s / trim(): Python excludes U+FEFF and includes U+001C–U+001F and
//     U+0085. pyStrip/PY_WS_RUN reproduce Python's set exactly.
//   • f-strings render None as "None" (label()).
//   • Tuple sort compares strings by code point; JS < compares UTF-16 code
//     units. cmpCodePoints keeps the Python order for astral characters.
//   • dict.get() returns None for a missing key; get() maps undefined → null.
//
// Output records keep the reference's shape: groups {key, isDraft, isArchived,
// fieldData}, meetings {legacyId, groupKey, isDraft, isArchived, fieldData}.
// A meeting's `group` is its group's legacy key and `day` the day name; the
// planner resolves both to Webflow IDs.

export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Fields that only make sense together are voted as one unit, so a group never
// ends up with a pin, contact or address combination that no meeting had.
export const UNITS = [
  ['address', 'latitude', 'longitude', 'geocoded-address', 'approximate'],
  ['location', 'location-notes', 'region', 'sub-region'],
  ['timezone'],
  ['group-notes'],
  ['website'],
  ['email', 'phone'],
  ['mailing-address'],
  ['contact-1-name', 'contact-1-email', 'contact-1-phone'],
  ['contact-2-name', 'contact-2-email', 'contact-2-phone'],
  ['contact-3-name', 'contact-3-email', 'contact-3-phone'],
];
// A group can run different Zoom rooms per meeting, so this unit is only the
// group's default; meetings that differ get an override instead of losing a vote.
export const ONLINE = ['conference-url', 'conference-url-notes'];
const PRIVATE = new Set([
  'mailing-address', 'geocoded-address', 'contact-1-name', 'contact-1-email', 'contact-1-phone',
  'contact-2-name', 'contact-2-email', 'contact-2-phone', 'contact-3-name', 'contact-3-email',
  'contact-3-phone',
]);
const RICH = new Set(['location-notes', 'group-notes', 'conference-url-notes', 'notes']);

// Python str.isspace() — the set both str.strip() and re's \s use.
const PY_WS = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const PY_WS_EDGES = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, 'g');
const PY_WS_RUN = new RegExp(`[${PY_WS}]+`, 'g');

export function pyStrip(s) {
  return s.replace(PY_WS_EDGES, '');
}

// Mirrors stripHtml in src/routes/meetings/+server.ts verbatim (JS whitespace
// semantics on purpose: it is what the live feed shows visitors).
export function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const get = (fd, key) => (fd[key] === undefined ? null : fd[key]);
const pyFmt = (v) => (v === null || v === undefined ? 'None' : String(v));

function cmpCodePoints(a, b) {
  if (a === b) return 0;
  const A = [...a];
  const B = [...b];
  for (let i = 0; i < Math.min(A.length, B.length); i++) {
    if (A[i] !== B[i]) return A[i].codePointAt(0) - B[i].codePointAt(0);
  }
  return A.length - B.length;
}

export function norm(s) {
  return pyStrip(s ? String(s) : '').toLowerCase().replace(PY_WS_RUN, ' ');
}

export function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'group';
}

function val(item, key) {
  let v = item.fieldData[key];
  // Stray outer spaces are typing noise that HTML rendering hides; keeping
  // them would split one real value into several in the vote.
  if (typeof v === 'string') v = pyStrip(v);
  return v === undefined || v === null || v === '' ? null : v;
}

// What a visitor would see for this value (rich text is flattened in the feed).
function shown(field, v) {
  if (v === null) return '';
  return RICH.has(field) ? stripHtml(v) : pyStrip(String(v));
}

export function groupKey(item) {
  const g = pyStrip(item.fieldData.group || '');
  if (g) return 'g:' + norm(g);
  // Ungrouped meetings are one-meeting rural groups named after the meeting;
  // those sharing name AND address form one group.
  return 's:' + norm(item.fieldData.name) + '|' + norm(item.fieldData.address);
}

// Ties go to the oldest item: stable between runs, unlike lastUpdated, which
// the hourly geocoder bumps.
function byAge(a, b) {
  return cmpCodePoints(a.createdOn || '', b.createdOn || '') || cmpCodePoints(a.id, b.id);
}

function vote(members, unit) {
  let voters = members.filter((m) => !m.isDraft);
  if (voters.length === 0) voters = members;
  const keyOf = (m) => JSON.stringify(unit.map((f) => val(m, f)));
  const counts = new Map();
  for (const m of voters) counts.set(keyOf(m), (counts.get(keyOf(m)) || 0) + 1);
  const best = Math.max(...counts.values());
  for (const m of [...voters].sort(byAge)) {
    const k = keyOf(m);
    if (counts.get(k) === best) {
      const values = JSON.parse(k);
      return { winner: Object.fromEntries(unit.map((f, i) => [f, values[i]])), counts };
    }
  }
  throw new Error('unreachable');
}

// The CMS can't list a group's meetings from the group, so every meeting's
// name starts with its group: searching the group name finds them all.
function label(groupName, day, time) {
  return pyStrip(`${pyFmt(groupName)} · ${pyFmt(day)} ${pyFmt(time)}`);
}

const sameValues = (a, b, unit) => unit.every((f) => a[f] === b[f]);

export function migrate(v1Items) {
  const items = v1Items.filter((i) => !i.isArchived); // archived: backup only
  const clusters = new Map();
  for (const i of [...items].sort(byAge)) {
    const k = groupKey(i);
    if (!clusters.has(k)) clusters.set(k, []);
    clusters.get(k).push(i);
  }

  const groups = [];
  const meetings = [];
  const conflicts = [];
  const used = new Set();
  for (const [key, members] of clusters) {
    const standalone = key.startsWith('s:');
    const first = members[0];
    const rawName = standalone ? first.fieldData.name : first.fieldData.group;
    // The reference crashes here too (None.strip()); a group without a name
    // is not something to guess about.
    if (typeof rawName !== 'string') throw new Error(`v1 item ${first.id} has no ${standalone ? 'name' : 'group'}`);
    const name = pyStrip(rawName);
    const base = slugify(name);
    let slug = base;
    for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`;
    used.add(slug);

    const gf = { name, slug };
    for (const unit of [...UNITS, ONLINE]) {
      const { winner, counts } = vote(members, unit);
      Object.assign(gf, winner);
      if (counts.size > 1 && unit !== ONLINE) {
        const loserRows = [];
        for (const m of members) {
          const mine = Object.fromEntries(unit.map((f) => [f, val(m, f)]));
          if (!sameValues(mine, winner, unit)) {
            loserRows.push({
              meeting: get(m.fieldData, 'slug'),
              value: mine,
              visible_change: unit.some((f) => !PRIVATE.has(f) && shown(f, mine[f]) !== shown(f, winner[f])),
            });
          }
        }
        conflicts.push({ group: name, unit: [...unit], kept: winner, replaced: loserRows });
      }
    }
    gf['hide-from-meeting-finder'] = false;
    // v1 feeds group:null for ungrouped meetings; hiding the name keeps
    // cutover invisible to visitors.
    gf['hide-group-name'] = standalone;
    gf['legacy-group-key'] = key;
    groups.push({ key, isDraft: true, isArchived: false, fieldData: gf });

    const U = gf['conference-url'];
    const N = gf['conference-url-notes'];
    for (const m of members) {
      const fd = m.fieldData;
      const u = val(m, 'conference-url');
      const nt = val(m, 'conference-url-notes');
      const noOnline = u === null && U !== null;
      const urlOverride = u !== null && u !== U ? u : null;
      const notesOverride = nt !== null && nt !== (noOnline ? null : N) ? nt : null;
      const display = pyStrip(fd.name || '');
      const mf = {
        name: label(name, get(fd, 'day'), get(fd, 'time')),
        slug: get(fd, 'slug'), // verbatim: every TSML link and CMS URL must survive
        group: key, // → group item ID at import
        day: get(fd, 'day'), // → Option ID at import
        'start-time': get(fd, 'time'),
        'end-time': val(m, 'end-time'),
        types: val(m, 'types'),
        notes: val(m, 'notes'),
        'display-name': display !== name ? display : null,
        'conference-url-override': urlOverride,
        'conference-url-notes-override': notesOverride,
        'no-online-option': noOnline,
        'starts-on': null,
        'ends-on': null,
        'hide-from-meeting-finder': Boolean(m.isDraft),
        'legacy-item-id': m.id,
        'legacy-author': val(m, 'author'),
      };
      // A meeting with no URL of its own can't clear inherited notes; flag it
      // so the parity check explains any resulting difference.
      if (!noOnline && nt === null && N !== null && u !== null) {
        conflicts.push({
          group: name,
          unit: ['conference-url-notes'],
          kept: { inherits: N },
          replaced: [{ meeting: get(fd, 'slug'), value: null, visible_change: true }],
        });
      }
      meetings.push({ legacyId: m.id, groupKey: key, isDraft: true, isArchived: false, fieldData: mf });
    }
  }
  return { groups, meetings, conflicts };
}
