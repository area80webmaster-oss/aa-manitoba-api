// Daily de-indexer: sets the Events collection's `search-indexing` Option to
// "noindex" on events whose end date has passed, then publishes those items.
// The Events page template renders that field into a robots meta tag, so past
// event pages drop out of Google automatically while future ones stay indexed.
//
// Why this exists: Webflow's native per-item "Sitemap indexing" toggle is NOT
// settable via the Data API (verified Sep 2026 — the item write schema has no
// SEO property), so we drive an ordinary CMS field bound into the template
// head instead.
//
// Safety rules:
//   • Only touches items that are past, published, not archived/draft, have
//     no Repeats value (recurring-series anchors are evergreen), and don't
//     already carry a search-indexing value.
//   • Skips publishing any item that already had unpublished edits before
//     this run (lastUpdated > lastPublished) — we never push someone else's
//     draft changes live. Those are logged for a human.
//   • DRY_RUN=1 prints the plan without writing.
//
// Env: WEBFLOW_WRITE_TOKEN (scope: CMS read + write), optional DRY_RUN=1.

const COLLECTION_ID = '6a156a1f0ac578734e57693d';
const NOINDEX_OPTION_ID = 'c3889a11c33654d0237211f8603a7c10';
const API = 'https://api.webflow.com/v2';
const GRACE_MS = 24 * 60 * 60 * 1000; // don't de-index until a full day after the event ends

const token = process.env.WEBFLOW_WRITE_TOKEN;
const dryRun = process.env.DRY_RUN === '1';

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

// 1. Fetch every item (staged endpoint — includes pending values).
const items = [];
for (let offset = 0; ; offset += 100) {
  const page = await api(`/collections/${COLLECTION_ID}/items?limit=100&offset=${offset}`);
  items.push(...page.items);
  if (items.length >= page.pagination.total) break;
}
console.log(`Fetched ${items.length} items`);

// 2. Select candidates.
const cutoff = Date.now() - GRACE_MS;
const skippedPendingEdits = [];
const candidates = [];
for (const item of items) {
  const f = item.fieldData || {};
  if (item.isArchived || item.isDraft) continue;
  if (f.repeats) continue; // recurring-series anchors stay indexable
  if (f['search-indexing']) continue; // already handled
  const end = Date.parse(f['end-date-time'] || '');
  if (Number.isNaN(end) || end >= cutoff) continue;
  const pendingEdits = !item.lastPublished || item.lastUpdated > item.lastPublished;
  if (pendingEdits) {
    skippedPendingEdits.push(f.slug || item.id);
    continue; // a human should publish these — we only log them
  }
  candidates.push(item.id);
}

console.log(`Past events needing noindex: ${candidates.length}`);
if (skippedPendingEdits.length) {
  console.log(
    `SKIPPED ${skippedPendingEdits.length} item(s) with unpublished edits (need a human): ` +
      skippedPendingEdits.slice(0, 20).join(', ')
  );
}
if (dryRun) {
  console.log('DRY_RUN=1 — no writes performed.');
  process.exit(0);
}

// 3. Write + publish in batches of 100.
for (let i = 0; i < candidates.length; i += 100) {
  const batch = candidates.slice(i, i + 100);
  await api(`/collections/${COLLECTION_ID}/items`, {
    method: 'PATCH',
    body: JSON.stringify({
      items: batch.map((id) => ({ id, fieldData: { 'search-indexing': NOINDEX_OPTION_ID } })),
    }),
  });
  await api(`/collections/${COLLECTION_ID}/items/publish`, {
    method: 'POST',
    body: JSON.stringify({ itemIds: batch }),
  });
  console.log(`Batch ${i / 100 + 1}: updated + published ${batch.length} items`);
}

console.log('Done.');
