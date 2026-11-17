// Reads src/lib/meetings-source.json, the one switch for which CMS structure
// is live: the /meetings route, the geocoder, the legacy watch and the v1→v2
// sync all follow it. Scripts fail loudly on a bad file (the route instead
// falls back to v1 so the public feed never breaks).
import { readFileSync } from 'node:fs';

export const SOURCE_FILE = new URL('../../src/lib/meetings-source.json', import.meta.url);
export const V1_MEETINGS_ID = '6a101256165031ecf1106518'; // Meetings (legacy after cutover)
export const V2_GROUPS_ID = '6af5eb2a3787a4d79902fc64'; // Groups: holds address + pin in v2

export function parseSource(text) {
  const config = JSON.parse(text);
  if (config?.source !== 'v1' && config?.source !== 'v2') {
    throw new Error(`meetings-source.json: source must be "v1" or "v2", got ${JSON.stringify(config?.source)}`);
  }
  // `since` marks the cutover; the legacy watch flags v1 edits after it.
  if (config.source === 'v2' && (typeof config.since !== 'string' || Number.isNaN(Date.parse(config.since)))) {
    throw new Error('meetings-source.json: source "v2" needs an ISO timestamp in "since"');
  }
  return config;
}

export function readSource() {
  return parseSource(readFileSync(SOURCE_FILE, 'utf8'));
}

// The address and its map pin live on the meeting in v1 and on the group in v2.
export function geocodeCollectionFor(source) {
  return source === 'v2' ? V2_GROUPS_ID : V1_MEETINGS_ID;
}
