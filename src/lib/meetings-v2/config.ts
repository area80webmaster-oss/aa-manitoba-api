// Collection IDs are identifiers, not secrets.
export const GROUPS_COLLECTION_ID = '6af5eb2a3787a4d79902fc64';
export const GROUP_MEETINGS_COLLECTION_ID = '6af5eb5d981a96b100d3c8cc';

// During the parallel run every v2 item is a Webflow draft so nothing publishes
// on the site; drafts must therefore count as live or the feed would be empty.
// At cutover this flips to false so "draft = hidden" matches the old /meetings
// behaviour.
export const INCLUDE_DRAFTS = true;
