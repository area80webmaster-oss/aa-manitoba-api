// Which CMS structure the public /meetings feed reads: 'v1' = the flat
// Meetings collection, 'v2' = Groups + Group Meetings. The value lives in
// meetings-source.json so the route, the geocoder and the sync job all follow
// one switch; it is changed only by scripts/meetings-switch.sh.
import config from './meetings-source.json';

export type MeetingsSource = 'v1' | 'v2';

function isSource(v: unknown): v is MeetingsSource {
	return v === 'v1' || v === 'v2';
}

// The scripts and tests reject a bad file loudly; at runtime a bad value must
// not take the feed down, so it reads as v1, the collection that always works.
export const MEETINGS_SOURCE: MeetingsSource = isSource(config.source) ? config.source : 'v1';
if (!isSource(config.source)) console.error('[meetings] meetings-source.json has no valid source; serving v1');

// ?source=v1|v2 lets the switch script check either reader on production
// without changing what everyone else gets. Both are the same public data.
export function requestedSource(param: string | null): MeetingsSource | null {
	return isSource(param) ? param : null;
}
