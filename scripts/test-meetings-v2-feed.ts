// Run: node scripts/test-meetings-v2-feed.ts   (Node 22.18+/24 strips types natively)
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFeed, manitobaDate, manitobaToday } from '../src/lib/meetings-v2/feed.ts';
import { getDayOptions, listAllItems } from '../src/lib/meetings-v2/webflow.ts';

const here = dirname(fileURLToPath(import.meta.url));
// Optional real-data check: the fixture holds private contact details, so it
// lives outside this public repo and is passed by path; values are never printed.
const REAL_FIXTURE = process.env.MEETINGS_V2_REAL_FIXTURE ?? '';

let failures = 0;
const fail = (msg: string) => {
	failures++;
	console.log(`  FAIL ${msg}`);
};

// Differences are reported as slug + field names only, never values.
function runCase(label: string, c: any, groups: any[], meetings: any[], dayOptions: any): boolean {
	const { rows, skipped } = buildFeed(groups, meetings, dayOptions, c.today, c.includeDrafts);
	let ok = true;
	if (JSON.stringify(rows) !== JSON.stringify(c.expected)) {
		ok = false;
		fail(`${label}: rows differ (got ${rows.length}, expected ${c.expected.length})`);
		const exp = new Map<string, any>(c.expected.map((r: any) => [r.slug, r]));
		for (const r of rows) {
			const e = exp.get(r.slug);
			if (!e) fail(`${label}: unexpected row ${r.slug}`);
			else if (JSON.stringify(r) !== JSON.stringify(e)) {
				const keys = [...new Set([...Object.keys(r), ...Object.keys(e)])].filter(
					(k) => JSON.stringify(r[k]) !== JSON.stringify(e[k])
				);
				fail(`${label}: ${r.slug} differs in [${keys.join(', ')}]${
					JSON.stringify(Object.keys(r)) !== JSON.stringify(Object.keys(e)) ? ' (key order/set)' : ''
				}`);
			}
			exp.delete(r.slug);
		}
		for (const slug of exp.keys()) fail(`${label}: missing row ${slug}`);
	}
	if (JSON.stringify(skipped) !== JSON.stringify(c.expectedSkipped)) {
		ok = false;
		fail(`${label}: skipped differ (got ${skipped.length}, expected ${c.expectedSkipped.length})`);
	}
	return ok;
}

// (a) synthetic fixture
{
	const fx = JSON.parse(readFileSync(join(here, 'fixtures/meetings-v2-synthetic.json'), 'utf8'));
	let pass = 0;
	fx.cases.forEach((c: any, i: number) => {
		const label = `synthetic[${i}${c.variant ? ':' + c.variant : ''}]`;
		if (runCase(label, c, c.groups ?? fx.groups, c.meetings ?? fx.meetings, fx.dayOptions)) pass++;
	});
	console.log(`synthetic fixture: ${pass}/${fx.cases.length} cases passed`);
}

// (a2) edge case the shared fixture lacks: empty-string overrides must fall back
// (Python `or`), plus NaN latitude, hidden group name and the starts-on window.
// Expected values were produced by feed_v2_model.build_feed on the same input.
{
	const groups = [
		{
			id: 'g',
			lastUpdated: '2026-11-01T00:00:00.000Z',
			fieldData: {
				name: 'G',
				'conference-url': 'https://x.test/z',
				'conference-url-notes': '<p>gn</p>',
				latitude: 'abc',
				longitude: '-97.1',
				'hide-group-name': true,
				email: 'e@x.test',
				phone: '(204) 555-0100',
				approximate: '  yes '
			}
		}
	];
	const meetings = [
		{
			id: 'm',
			lastUpdated: '2026-11-02T00:00:00.000Z',
			fieldData: {
				slug: 's',
				'display-name': '',
				group: 'g',
				day: 'd',
				'conference-url-override': '',
				'conference-url-notes-override': '',
				'starts-on': '2026-11-13T04:59:00.000Z'
			}
		}
	];
	const expected =
		'[{"slug":"s","name":"G","day":5,"time":null,"end_time":null,"timezone":"America/Winnipeg","types":[],"location":null,"formatted_address":null,"region":null,"sub_region":null,"latitude":null,"longitude":-97.1,"approximate":"yes","notes":null,"location_notes":null,"group":null,"group_notes":null,"url":null,"conference_url":"https://x.test/z","conference_url_notes":"gn","updated":"2026-11-02 00:00:00","entity":null,"entity_email":"e@x.test","entity_phone":"+12045550100"}]';
	const days = { d: 'Friday' };
	const on = JSON.stringify(buildFeed(groups, meetings, days, '2026-11-12', true).rows);
	const before = buildFeed(groups, meetings, days, '2026-11-11', true).rows.length;
	if (on === expected && before === 0) console.log('edge case: 2/2 passed');
	else fail(`edge case: rowsMatch=${on === expected} beforeWindow=${before}`);
}

// (b) private real fixture
if (existsSync(REAL_FIXTURE)) {
	const r = JSON.parse(readFileSync(REAL_FIXTURE, 'utf8'));
	const cases: any[] = r.cases ?? [r];
	let pass = 0;
	cases.forEach((c, i) => {
		if (runCase(`real[${i}]`, c, c.groups ?? r.groups, c.meetings ?? r.meetings, c.dayOptions ?? r.dayOptions))
			pass++;
	});
	const c0 = cases[0];
	console.log(
		`real fixture: ${pass}/${cases.length} cases passed ` +
			`(${(c0.groups ?? r.groups).length} groups, ${(c0.meetings ?? r.meetings).length} meetings, ` +
			`${c0.expected.length} expected rows, ${c0.expectedSkipped.length} expected skipped)`
	);
} else {
	console.log('real fixture: not present, skipped');
}

// (c) Manitoba date arithmetic (fixed UTC-5, never Intl)
{
	const cases: [string, string][] = [
		['2026-11-12T23:30:00Z', '2026-11-12'],
		['2026-11-13T00:30:00Z', '2026-11-12'],
		['2026-11-13T04:59:00Z', '2026-11-12'],
		['2026-11-13T05:00:00Z', '2026-11-13'],
		['2026-07-01T04:59:59Z', '2026-06-30']
	];
	let pass = 0;
	for (const [iso, want] of cases) {
		const got = manitobaToday(Date.parse(iso));
		if (got === want) pass++;
		else fail(`manitobaToday(${iso}) = ${got}, want ${want}`);
	}
	const dates: [string, string | null][] = [
		['2026-11-13T04:59:59.000Z', '2026-11-12'],
		['2026-11-13T05:00:00.000Z', '2026-11-13'],
		['not a date', null]
	];
	for (const [iso, want] of dates) {
		const got = manitobaDate(iso);
		if (got === want) pass++;
		else fail(`manitobaDate(${iso}) = ${got}, want ${want}`);
	}
	console.log(`timezone: ${pass}/${cases.length + dates.length} passed`);
}

// (d) fetch layer with a stubbed fetch: pagination, parallel pages, 429 retry, validation
{
	const realFetch = globalThis.fetch;
	const calls: string[] = [];
	let throttled = 0;
	const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
		new Response(JSON.stringify(body), { status, headers });
	globalThis.fetch = (async (url: string) => {
		calls.push(url);
		const u = new URL(url);
		if (u.pathname.endsWith('/items')) {
			const offset = Number(u.searchParams.get('offset'));
			if (offset === 200 && throttled++ < 2) return json({}, 429, { 'retry-after': '0' });
			const items = Array.from({ length: Math.min(100, 250 - offset) }, (_, i) => ({ id: `i${offset + i}` }));
			return json({ items, pagination: { total: 250 } });
		}
		return json({ fields: [{ slug: 'day', validations: { options: [{ id: 'a', name: 'Monday' }] } }] });
	}) as typeof fetch;
	try {
		const items = await listAllItems('col', 'tok');
		const ids = items.map((i) => i.id);
		const orderOk = ids.every((id, i) => id === `i${i}`);
		if (items.length === 250 && orderOk && throttled === 3) console.log('fetch layer: pagination + 429 retry passed');
		else fail(`fetch layer: items=${items.length} ordered=${orderOk} throttled=${throttled}`);
		const days = await getDayOptions('col', 'tok');
		if (JSON.stringify(days) !== '{"a":"Monday"}') fail('fetch layer: day options mismatch');
		globalThis.fetch = (async () => json({ items: 'nope', pagination: { total: 1 } })) as typeof fetch;
		let threw = false;
		try {
			await listAllItems('col', 'tok');
		} catch {
			threw = true;
		}
		if (!threw) fail('fetch layer: malformed items response did not throw');
		globalThis.fetch = (async () => json({}, 500)) as typeof fetch;
		threw = false;
		try {
			await getDayOptions('col', 'tok');
		} catch {
			threw = true;
		}
		if (!threw) fail('fetch layer: HTTP 500 did not throw');
	} finally {
		globalThis.fetch = realFetch;
	}
}

if (failures > 0) {
	console.log(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log('\nall tests passed');
