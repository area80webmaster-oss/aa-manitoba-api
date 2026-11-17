// Run: node scripts/test-meetings-source.mjs
// Guards the v1/v2 switch: the committed file is valid, every consumer reads
// it the same way, and the retired v1→v2 sync can never run on its own again.
import { readFileSync } from 'node:fs';
import { geocodeCollectionFor, parseSource, readSource, V1_MEETINGS_ID, V2_GROUPS_ID } from './lib/meetings-source.mjs';
import { syncAllowed } from './sync-meetings-v2.mjs';

let failures = 0;
const check = (ok, msg) => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};
const throws = (fn) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

// The committed switch file.
const live = readSource();
check(live.source === 'v1' || live.source === 'v2', 'committed meetings-source.json has a valid source');

// Parsing.
check(parseSource('{"source":"v1","since":null}').source === 'v1', 'v1 without since parses');
check(parseSource('{"source":"v2","since":"2026-11-17T12:00:00.000Z","cutoverAt":"2026-11-17T12:00:00.000Z"}').source === 'v2', 'v2 with since and cutoverAt parses');
check(throws(() => parseSource('{"source":"v2","since":"2026-11-17T12:00:00.000Z"}')), 'v2 without cutoverAt is rejected');
check(throws(() => parseSource('{"source":"v2","since":null}')), 'v2 without since is rejected');
check(throws(() => parseSource('{"source":"v2","since":"soon"}')), 'v2 with a bad since is rejected');
check(throws(() => parseSource('{"source":"V2"}')), 'a misspelt source is rejected');
check(throws(() => parseSource('{}')), 'a missing source is rejected');
check(throws(() => parseSource('not json')), 'invalid JSON is rejected');

// Consumers.
check(geocodeCollectionFor('v1') === V1_MEETINGS_ID, 'geocoder targets Meetings on v1');
check(geocodeCollectionFor('v2') === V2_GROUPS_ID, 'geocoder targets Groups on v2');
check(syncAllowed({ source: 'v1', since: null }) === true, 'v1→v2 sync may run before the cutover');
const t = '2026-11-17T12:00:00.000Z';
check(syncAllowed({ source: 'v2', since: t, cutoverAt: t }) === false, 'v1→v2 sync refuses once v2 is live');
check(syncAllowed({ source: 'v1', since: t, cutoverAt: t }) === false, 'v1→v2 sync stays retired after a rollback');
check(syncAllowed({ source: 'v1', since: null, cutoverAt: t }) === false, 'cutoverAt alone retires the sync');
check(parseSource('{"source":"v1","since":null,"cutoverAt":"2026-11-17T12:00:00.000Z"}').cutoverAt !== null, 'a rollback keeps the cutover time');
check(throws(() => parseSource('{"source":"v1","cutoverAt":"soon"}')), 'a bad cutoverAt is rejected');
check(throws(() => parseSource('{"source":"v1","since":"later"}')), 'v1 with a bad since is rejected');

// The route's own copy of the rule (src/lib/meetings-source.ts) must accept
// exactly the same values; it imports the same JSON file.
const ts = readFileSync(new URL('../src/lib/meetings-source.ts', import.meta.url), 'utf8');
check(ts.includes("v === 'v1' || v === 'v2'"), 'route accepts exactly v1 and v2');
check(ts.includes("import config from './meetings-source.json'"), 'route reads the same switch file');

// The retired sync workflow must stay manual-only.
const wf = readFileSync(new URL('../.github/workflows/sync-meetings-v2.yml', import.meta.url), 'utf8');
const on = wf.slice(wf.indexOf('\non:'), wf.indexOf('\nconcurrency:'));
check(!/^\s*schedule:/m.test(on), 'sync workflow has no schedule');
check(!/^\s*push:/m.test(on), 'sync workflow does not run on pushes');
check(/^\s*workflow_dispatch:/m.test(on), 'sync workflow stays manual');

console.log(failures ? `${failures} failure(s)` : 'meetings-source tests passed');
process.exit(failures ? 1 : 0);
