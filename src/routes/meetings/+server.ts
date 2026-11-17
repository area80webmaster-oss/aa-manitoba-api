import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';
import { MEETINGS_SOURCE, requestedSource, type MeetingsSource } from '$lib/meetings-source';
import { GROUPS_COLLECTION_ID, GROUP_MEETINGS_COLLECTION_ID, INCLUDE_DRAFTS } from '$lib/meetings-v2/config';
import { buildFeed, manitobaToday } from '$lib/meetings-v2/feed';
import { feedDeadline, getDayOptions, listAllItems } from '$lib/meetings-v2/webflow';

const WEBFLOW_API_BASE = 'https://api.webflow.com/v2';
const COLLECTION_ID = '6a101256165031ecf1106518';

const DAY_MAP: Record<string, number> = {
	Sunday: 0,
	Monday: 1,
	Tuesday: 2,
	Wednesday: 3,
	Thursday: 4,
	Friday: 5,
	Saturday: 6
};

// Maps Webflow full-name types to code4recovery spec codes.
// Unknown types are passed through unchanged so they're visible in the feed.
const TYPE_MAP: Record<string, string> = {
	Open: 'O',
	Closed: 'C',
	Discussion: 'D',
	Speaker: 'SP',
	'Big Book': 'B',
	'Step Study': 'ST',
	'12 Steps & 12 Traditions': '12x12',
	'Tradition Study': 'TR',
	Literature: 'LIT',
	Newcomer: 'BE',
	Women: 'W',
	Men: 'M',
	'Young People': 'Y',
	LGBTQ: 'LGBTQ',
	Candlelight: 'CAN',
	Birthday: 'H',
	Meditation: 'MED',
	'As Bill Sees It': 'ABSI',
	'Daily Reflections': 'DR',
	Grapevine: 'GR',
	'Living Sober': 'LS',
	'11th Step Meditation': '11',
	'Dual Diagnosis': 'DD',
	Secular: 'A',
	'Wheelchair Access': 'X',
	'Wheelchair-Accessible Bathroom': 'XB',
	'Cross Talk Permitted': 'XT',
	'Fragrance Free': 'FF',
	'Smoking Permitted': 'SM',
	'Child-Friendly': 'CF',
	'Babysitting Available': 'BA',
	Breakfast: 'BRK',
	'Location Temporarily Closed': 'TC',
	Seniors: 'SEN',
	'People of Color': 'POC',
	'Native American': 'N',
	Indigenous: 'NDG',
	Professionals: 'P',
	Gay: 'G',
	Lesbian: 'L',
	Bisexual: 'BI',
	Transgender: 'T',
	'Non-Binary': 'NB',
	'Concurrent with Alateen': 'AL',
	'Concurrent with Al-Anon': 'AL-AN',
	'Proof of Attendance': 'POA',
	'Digital Basket': 'DB',
	Outdoor: 'OUT',
	// "Online Meeting" is intentionally omitted — conference_url signals online status
};

const SECURITY_HEADERS: Record<string, string> = {
	// CORS is set dynamically in src/hooks.server.ts after origin verification.
	// Keep only the static, non-Origin security headers here.
	'X-Content-Type-Options': 'nosniff',
	'X-Robots-Tag': 'noindex, nofollow',
	'Referrer-Policy': 'no-referrer'
};

function stripHtml(html: string | null | undefined): string {
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

function toUpdatedTimestamp(iso: string | null | undefined): string | null {
	if (!iso) return null;
	// Spec expects "YYYY-MM-DD HH:MM:SS" UTC
	return iso.replace('T', ' ').replace(/\.\d+Z$/, '');
}

function mapTypes(raw: string | null | undefined): string[] {
	if (!raw) return [];
	return raw
		.split(',')
		.map((t) => t.trim())
		.filter((t) => t && t !== 'Online Meeting' && t !== "Chair's Choice")
		.map((t) => TYPE_MAP[t] ?? t);
}

// Normalize North American phone numbers to E.164 (e.g. "+12045551234").
// Numbers that can't be confidently parsed are returned trimmed, unchanged.
function normalizePhone(raw: string | null | undefined): string | null {
	if (!raw) return null;
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const digits = trimmed.replace(/\D/g, '');
	if (digits.length === 10) return `+1${digits}`;
	if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
	return trimmed;
}

async function fetchAllMeetings(token: string, signal?: AbortSignal): Promise<unknown[]> {
	const items: unknown[] = [];
	const limit = 100;
	let offset = 0;
	let total = Infinity;

	while (items.length < total) {
		const res = await fetch(
			`${WEBFLOW_API_BASE}/collections/${COLLECTION_ID}/items?limit=${limit}&offset=${offset}`,
			{
				headers: {
					Authorization: `Bearer ${token}`,
					'accept-version': '1.0.0'
				},
				signal
			}
		);

		if (!res.ok) {
			const body = await res.text();
			throw new Error(`Webflow API ${res.status}: ${body}`);
		}

		const data = (await res.json()) as { items: unknown[]; pagination: { total: number } };
		items.push(...data.items);
		total = data.pagination.total;
		offset += limit;
	}

	return items;
}

// A meeting that meets in person must never disappear over address
// vagueness: TSML UI turns approximate="yes" — typed by hand or guessed by
// comma-counting the address — into the Inactive shelf, which kept knocking
// real groups off the site. In-person meetings therefore always feed "no";
// one without coordinates simply lists without a map pin until the geocoder
// or a human supplies one. "yes" is honored only for online meetings, where
// it correctly renders them online-only.
function approximateFor(f: Record<string, string | null | undefined>): string | null {
	if (!f['conference-url']) return 'no';
	const explicit = f.approximate?.trim() || null;
	return explicit ?? (f.latitude && f.longitude ? 'no' : null);
}

function transformMeeting(item: Record<string, unknown>): Record<string, unknown> {
	const f = item.fieldData as Record<string, string | null | undefined>;

	const meeting: Record<string, unknown> = {
		slug: f.slug ?? null,
		name: f.name ?? null,
		day: f.day != null ? (DAY_MAP[f.day] ?? null) : null,
		time: f.time ?? null,
		end_time: f['end-time'] ?? null,
		timezone: f.timezone ?? 'America/Winnipeg',
		types: mapTypes(f.types),
		location: f.location ?? null,
		formatted_address: f.address ?? null,
		region: f.region ?? null,
		sub_region: f['sub-region'] ?? null,
		latitude: f.latitude != null ? parseFloat(f.latitude) : null,
		longitude: f.longitude != null ? parseFloat(f.longitude) : null,
		approximate: approximateFor(f),
		notes: stripHtml(f.notes) || null,
		location_notes: stripHtml(f['location-notes']) || null,
		group: f.group ?? null,
		group_notes: stripHtml(f['group-notes']) || null,
		url: f.website ?? null,
		conference_url: f['conference-url'] ?? null,
		conference_url_notes: stripHtml(f['conference-url-notes']) || null,
		updated: toUpdatedTimestamp(item.lastPublished as string)
	};

	// Contact persons are intentionally omitted from the public feed —
	// per-person names/emails/phones are sensitive and must never be exposed.

	// Entity (group-level contact info)
	if (f.email || f.phone) {
		meeting.entity = f.group ?? null;
		meeting.entity_email = f.email ?? null;
		meeting.entity_phone = normalizePhone(f.phone);
	}

	return meeting;
}

export const OPTIONS: RequestHandler = () => {
	// OPTIONS is handled in src/hooks.server.ts after origin verification.
	// Returning 204 here too lets dev mode bypass the hook during local testing.
	return new Response(null, { status: 204, headers: SECURITY_HEADERS });
};


// Below this many rows a v2 build is treated as broken rather than served:
// the list holds ~410 meetings, and losing a quarter of them at once means a
// bad read or a mass mistake, not an edit anyone meant.
const MIN_V2_ROWS = 300;
// Netlify stops the function at 10 s; the v1 fallback only starts when it can
// still finish inside that.
const FUNCTION_BUDGET_MS = 9_500;
const MIN_FALLBACK_MS = 2_000;
// Degraded answers (stale or fallback) are cached briefly so recovery shows
// up within a minute instead of after the normal 5.
const SHORT_CACHE = 'public, max-age=60';

// Per-instance only: a cold instance has none.
let lastGoodV2: string | null = null;

function feedResponse(
	body: string,
	source: MeetingsSource | 'v1-fallback',
	extra: Record<string, string> = {}
): Response {
	return new Response(body, {
		status: 200,
		headers: {
			...SECURITY_HEADERS,
			'Content-Type': 'application/json',
			// Cache for 5 minutes; serve stale for up to 60s while revalidating
			'Cache-Control': 'public, max-age=300, stale-while-revalidate=60',
			'X-Meetings-Source': source,
			...extra
		}
	});
}

function failedResponse(): Response {
	return new Response(JSON.stringify({ error: 'Failed to fetch meeting data' }), {
		status: 502,
		headers: { ...SECURITY_HEADERS, 'Content-Type': 'application/json' }
	});
}

async function buildV1(token: string, signal?: AbortSignal): Promise<string> {
	const raw = await fetchAllMeetings(token, signal);
	const meetings = (raw as Record<string, unknown>[])
		.filter((item) => !item.isArchived && !item.isDraft)
		.map(transformMeeting);
	return JSON.stringify(meetings);
}

// Same build as /meetings-v2, so what was verified there is what ships here.
async function buildV2(token: string): Promise<string> {
	const deadline = feedDeadline();
	const [groups, meetings, dayOptions] = await Promise.all([
		listAllItems(GROUPS_COLLECTION_ID, token, deadline),
		listAllItems(GROUP_MEETINGS_COLLECTION_ID, token, deadline),
		getDayOptions(GROUP_MEETINGS_COLLECTION_ID, token, deadline)
	]);
	const { rows, skipped } = buildFeed(groups, meetings, dayOptions, manitobaToday(), INCLUDE_DRAFTS);
	// Slug and reason only: meeting data must not reach the logs.
	for (const [slug, reason] of skipped) console.warn(`[meetings] v2 skipped ${slug}: ${reason}`);
	if (rows.length < MIN_V2_ROWS) throw new Error(`v2 feed has only ${rows.length} rows`);
	return JSON.stringify(rows);
}

export const GET: RequestHandler = async ({ url }) => {
	const started = Date.now();
	const token = env.WEBFLOW_API_TOKEN;

	if (!token) {
		return new Response(JSON.stringify({ error: 'Server configuration error' }), {
			status: 500,
			headers: { ...SECURITY_HEADERS, 'Content-Type': 'application/json' }
		});
	}

	const source = requestedSource(url.searchParams.get('source')) ?? MEETINGS_SOURCE;

	if (source === 'v1') {
		try {
			// After the cutover ?source=v1 is the frozen rollback copy, only ever
			// read to compare; keep it from sitting in caches as if current.
			const extra: Record<string, string> =
				MEETINGS_SOURCE === 'v2' ? { 'Cache-Control': SHORT_CACHE, 'X-Feed-Frozen': '1' } : {};
			return feedResponse(await buildV1(token), 'v1', extra);
		} catch (err) {
			console.error('[meetings] fetch failed:', err);
			return failedResponse();
		}
	}

	try {
		const body = await buildV2(env.WEBFLOW_V2_API_TOKEN || token);
		lastGoodV2 = body;
		return feedResponse(body, 'v2');
	} catch (err) {
		console.error('[meetings] v2 build failed:', err);
	}

	// A broken v2 read must never empty the meeting list: the last good v2
	// answer first, then the frozen v1 collection, then an error.
	if (lastGoodV2 !== null) {
		return feedResponse(lastGoodV2, 'v2', { 'X-Feed-Stale': '1', 'Cache-Control': SHORT_CACHE });
	}
	const remaining = FUNCTION_BUDGET_MS - (Date.now() - started);
	if (remaining >= MIN_FALLBACK_MS) {
		try {
			const body = await buildV1(token, AbortSignal.timeout(remaining));
			return feedResponse(body, 'v1-fallback', { 'Cache-Control': SHORT_CACHE });
		} catch (err) {
			console.error('[meetings] v1 fallback failed:', err);
		}
	}
	return failedResponse();
};
