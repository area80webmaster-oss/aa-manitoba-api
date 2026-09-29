// Geocode sweep: fills Latitude/Longitude (plus approximate:"no" and a
// geocoded-address marker) on Meetings items whose Address changed since the
// last successful geocode. The /webhooks/geocode-meeting endpoint handles the
// instant path when someone saves an item; this sweep is the backfill and the
// safety net behind it (webhooks can be missed; GitHub cron can't).
//
// Why this exists: TSML UI decides a meeting is "approximate" — and therefore
// not in-person, and inactive when it also has no online link — whenever the
// address has fewer than 4 comma-separated parts and no explicit approximate
// value (tsml-ui/src/helpers/load-meeting-data.ts). An explicit
// approximate:"no" plus real coordinates overrides that guess, so a precise
// geocode rescues imperfectly formatted addresses.
//
// Safety rules:
//   • A result is accepted only when the geocoder returns a street-level
//     match (tight bounding box). City/region-level matches are rejected and
//     logged for a human — a wrong pin is worse than no pin.
//   • Writes staged item data only — never publishes, never flips a draft.
//     The public /meetings feed reads staged items, so coordinates flow
//     through within its cache window without touching publish state.
//   • Items are skipped when Address equals the geocoded-address marker, so
//     the sweep is idempotent and webhook-triggered writes can't loop.
//   • DRAFT_ONLY=1 restricts writes to draft items (staging phase).
//   • DRY_RUN=1 prints the plan without writing.
//   • Nominatim usage policy: max 1 request/second, identifying User-Agent.
//
// Env: WEBFLOW_WRITE_TOKEN (scope: CMS read + write), optional DRY_RUN=1,
//      DRAFT_ONLY=1, GEOCODER_CONTACT (email/URL for the Nominatim UA).

const COLLECTION_ID = '6a101256165031ecf1106518'; // Meetings
const API = 'https://api.webflow.com/v2';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
// Manitoba venues: anything wider than ~2 km is a locality match, not a street
// address.
const MAX_BBOX_LAT_DEG = 0.02;
const MAX_BBOX_LON_DEG = 0.03;
// A road-only match (no house number found) is a guess along the whole
// street; only accept segments short enough (~400 m) that the midpoint is
// still a usable pin.
const MAX_ROAD_BBOX_LAT_DEG = 0.004;
const MAX_ROAD_BBOX_LON_DEG = 0.006;

const token = process.env.WEBFLOW_WRITE_TOKEN;
const dryRun = process.env.DRY_RUN === '1';
const draftOnly = process.env.DRAFT_ONLY === '1';
const stampExisting = process.env.STAMP_EXISTING === '1';
const contact = process.env.GEOCODER_CONTACT || 'https://aamanitoba.org';

if (!token) {
  console.error(
    'WEBFLOW_WRITE_TOKEN is not set. Create a Webflow site token with CMS ' +
      'read+write for the AA Manitoba site and add it as a GitHub Actions ' +
      'secret named WEBFLOW_WRITE_TOKEN.'
  );
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
};

async function api(path, options = {}, attempt = 0) {
  const res = await fetch(`${API}${path}`, { headers, ...options });
  if (res.status === 429 && attempt < 3) {
    const wait = Number(res.headers.get('Retry-After') || 60) * 1000;
    console.log(`429 rate limited — waiting ${wait / 1000}s`);
    await new Promise((r) => setTimeout(r, wait));
    return api(path, options, attempt + 1);
  }
  if (!res.ok) throw new Error(`${options.method || 'GET'} ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Returns { latitude, longitude } (5 decimal places, ~1.1 m) for a
// street-level match, or null when the address can't be resolved precisely.
// Nominatim only for now; if match quality on rural addresses ever
// disappoints, a Google Geocoding branch keyed off GOOGLE_MAPS_API_KEY slots
// in here (accept only ROOFTOP / RANGE_INTERPOLATED results).
async function geocode(address) {
  const url = `${NOMINATIM}?format=jsonv2&limit=1&countrycodes=ca&q=${encodeURIComponent(address)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': `aa-manitoba-meetings-geocoder/1.0 (${contact})` },
  });
  if (!res.ok) throw new Error(`Nominatim ${res.status}: ${await res.text()}`);
  const results = await res.json();
  if (!Array.isArray(results) || results.length === 0) return null;

  const r = results[0];
  const [south, north, west, east] = (r.boundingbox || []).map(Number);
  if (![south, north, west, east].every(Number.isFinite)) return null;
  const maxLat = r.category === 'highway' ? MAX_ROAD_BBOX_LAT_DEG : MAX_BBOX_LAT_DEG;
  const maxLon = r.category === 'highway' ? MAX_ROAD_BBOX_LON_DEG : MAX_BBOX_LON_DEG;
  if (north - south > maxLat || east - west > maxLon) {
    console.log(
      `  ↳ rejected: match too coarse (${r.category ?? '?'}/${r.type ?? '?'} "${r.display_name}")`
    );
    return null;
  }

  return {
    latitude: Number(r.lat).toFixed(5),
    longitude: Number(r.lon).toFixed(5),
  };
}

// 1. Fetch every item (staged endpoint — includes pending values).
const items = [];
for (let offset = 0; ; offset += 100) {
  const page = await api(`/collections/${COLLECTION_ID}/items?limit=100&offset=${offset}`);
  items.push(...page.items);
  if (items.length >= page.pagination.total) break;
}
console.log(`Fetched ${items.length} meetings.`);

// One-time migration (STAMP_EXISTING=1): meetings that predate the geocoder
// already carry hand-entered coordinates but no geocoded-address marker.
// Stamp marker := address WITHOUT re-geocoding, so their existing (often
// better-than-Nominatim) coordinates are kept and only future address edits
// trigger a geocode. Run this before enabling the webhook for all items.
if (stampExisting) {
  const toStamp = items.filter((item) => {
    if (item.isArchived) return false;
    if (draftOnly && !item.isDraft) return false;
    const f = item.fieldData ?? {};
    return (
      (f.address ?? '').trim() &&
      (f.latitude ?? '').trim() &&
      (f.longitude ?? '').trim() &&
      !(f['geocoded-address'] ?? '').trim()
    );
  });
  console.log(`STAMP_EXISTING: ${toStamp.length} items to stamp${dryRun ? ' — DRY RUN' : ''}.`);
  for (const item of toStamp) {
    console.log(`• stamp ${item.fieldData.name} (${item.id})`);
    if (!dryRun) {
      await api(`/collections/${COLLECTION_ID}/items/${item.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          fieldData: { 'geocoded-address': item.fieldData.address.trim() },
        }),
      });
      // Webflow rate limit is 60 requests/minute.
      await sleep(1100);
    }
  }
  console.log(`Stamping done (${toStamp.length}).`);
  process.exit(0);
}

// 2. Select candidates: an address exists and differs from the last one we
//    successfully geocoded.
const candidates = items.filter((item) => {
  if (item.isArchived) return false;
  if (draftOnly && !item.isDraft) return false;
  const f = item.fieldData ?? {};
  const address = (f.address ?? '').trim();
  if (!address) return false;
  const marker = (f['geocoded-address'] ?? '').trim();
  // Pre-geocoder items carry hand-entered coordinates but no marker — never
  // replace those (STAMP_EXISTING migrates them into the marker system).
  if (!marker && (f.latitude ?? '').trim() && (f.longitude ?? '').trim()) return false;
  return address !== marker;
});
console.log(
  `${candidates.length} need geocoding${draftOnly ? ' (drafts only)' : ''}${dryRun ? ' — DRY RUN' : ''}.`
);

// 3. Geocode and write back, one per second per Nominatim policy.
let updated = 0;
let unresolved = 0;
for (const item of candidates) {
  const f = item.fieldData;
  const address = f.address.trim();
  console.log(`• ${f.name} (${item.id}${item.isDraft ? ', draft' : ''}): "${address}"`);

  let coords;
  try {
    coords = await geocode(address);
  } catch (err) {
    console.error(`  ↳ geocoder error: ${err.message}`);
    unresolved += 1;
    await sleep(1100);
    continue;
  }

  if (!coords) {
    console.log('  ↳ could not resolve to a street-level location — left untouched');
    unresolved += 1;
    await sleep(1100);
    continue;
  }

  console.log(`  ↳ ${coords.latitude}, ${coords.longitude}`);
  if (!dryRun) {
    await api(`/collections/${COLLECTION_ID}/items/${item.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        fieldData: {
          latitude: coords.latitude,
          longitude: coords.longitude,
          approximate: 'no',
          'geocoded-address': address,
        },
      }),
    });
  }
  updated += 1;
  await sleep(1100);
}

console.log(
  `Done. ${updated} ${dryRun ? 'would be updated' : 'updated'}, ${unresolved} unresolved (listed above for a human).`
);
