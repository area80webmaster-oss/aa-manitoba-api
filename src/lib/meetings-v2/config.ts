// Collection IDs are identifiers, not secrets.
export const GROUPS_COLLECTION_ID = '6af5eb2a3787a4d79902fc64';
export const GROUP_MEETINGS_COLLECTION_ID = '6af5eb5d981a96b100d3c8cc';

// During the parallel run every v2 item was a Webflow draft, so drafts counted
// as live. At the cutover (2026-11-17) every public item was made non-draft and
// this went back to false, so "draft = hidden" works as it did in v1.
export const INCLUDE_DRAFTS = false;
