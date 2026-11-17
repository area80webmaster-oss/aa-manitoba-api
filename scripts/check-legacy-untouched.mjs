// Legacy watch: after the cutover the old flat Meetings collection is frozen
// (the rollback copy) and nobody should edit it. An edit there never reaches
// the website, so a volunteer who opened the wrong collection would think a
// meeting was updated when it wasn't. This fails the hourly job, which emails
// the repo, until the change is re-entered in Groups / Group Meetings and
// `since` in src/lib/meetings-source.json is moved past it.
//
// Read-only. The repo and its logs are public: prints slugs and timestamps
// only, never field values.
//
// Env: WEBFLOW_WRITE_TOKEN (only read here).
import { V1_MEETINGS_ID, readSource } from './lib/meetings-source.mjs';

const { source, since } = readSource();
if (source !== 'v2') {
  console.log(`meetings-source.json says "${source}": the old collection is live, nothing to watch.`);
  process.exit(0);
}

const token = process.env.WEBFLOW_WRITE_TOKEN;
if (!token) {
  console.error('WEBFLOW_WRITE_TOKEN is not set.');
  process.exit(1);
}

const items = [];
for (let offset = 0; ; offset += 100) {
  const res = await fetch(
    `https://api.webflow.com/v2/collections/${V1_MEETINGS_ID}/items?limit=100&offset=${offset}`,
    { headers: { Authorization: `Bearer ${token}`, 'accept-version': '1.0.0' } }
  );
  // Status only: a response body can echo field values.
  if (!res.ok) throw new Error(`Webflow API ${res.status} reading the old Meetings collection`);
  const page = await res.json();
  items.push(...page.items);
  if (!page.items.length || items.length >= page.pagination.total) break;
}

const cutover = Date.parse(since);
const edited = items.filter((i) => Date.parse(i.lastUpdated ?? '') > cutover);
console.log(`Old Meetings collection: ${items.length} items, ${edited.length} edited since the cutover (${since}).`);
if (edited.length) {
  for (const i of edited) console.log(`  • ${i.fieldData?.slug ?? i.id} edited ${i.lastUpdated}`);
  console.log(
    '::error::Someone edited the OLD Meetings collection after the switch to Groups + Group Meetings. ' +
      'Those edits do not show on the website. Re-enter them in the new collections, then move ' +
      '"since" in src/lib/meetings-source.json past the newest edit above.'
  );
  process.exit(1);
}
