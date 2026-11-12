// Pure feed builder for /meetings-v2. Port of build_feed() in
// meetings-restructure/tools/feed_v2_model.py; keep the two in lockstep.
// No imports and only erasable TypeScript so plain `node` can run it in tests.

type Fields = Record<string, any>;

export interface WebflowItem {
	id: string;
	isDraft?: boolean;
	isArchived?: boolean;
	lastUpdated?: string | null;
	fieldData?: Fields | null;
}

export type DayOptions = Record<string, string>;
export type Skipped = [string | null, string];
export interface FeedResult {
	rows: Record<string, unknown>[];
	skipped: Skipped[];
}

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
	Outdoor: 'OUT'
	// "Online Meeting" is intentionally omitted: conference_url signals online status.
};

// Manitoba is permanently UTC-5 since 2026-11-01. Runtime tzdata (Node 20 on
// Netlify) still applies the old UTC-6 rule, so Intl/America/Winnipeg would
// give the wrong date for hours each day; the offset is fixed instead.
const MB_OFFSET_MS = -5 * 60 * 60 * 1000;

export function manitobaToday(nowMs: number = Date.now()): string {
	return new Date(nowMs + MB_OFFSET_MS).toISOString().slice(0, 10);
}

// Returns null for an unparseable timestamp. Python's version raises there;
// here an unreadable window bound is ignored so the meeting stays listed
// rather than one bad CMS value taking the whole feed down.
export function manitobaDate(iso: string): string | null {
	const t = new Date(iso).getTime();
	if (Number.isNaN(t)) return null;
	return new Date(t + MB_OFFSET_MS).toISOString().slice(0, 10);
}

function inWindow(fd: Fields, today: string): boolean {
	if (fd['starts-on']) {
		const start = manitobaDate(fd['starts-on']);
		if (start !== null && today < start) return false;
	}
	if (fd['ends-on']) {
		const end = manitobaDate(fd['ends-on']);
		if (end !== null && today > end) return false;
	}
	return true;
}

// Helpers below are copies of the private helpers in src/routes/meetings/+server.ts.
// Non-string input is treated as absent: Webflow plain-text fields are strings,
// and the originals would throw on anything else.

function stripHtml(html: unknown): string {
	if (!html || typeof html !== 'string') return '';
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

function mapTypes(raw: unknown): string[] {
	if (!raw || typeof raw !== 'string') return [];
	return raw
		.split(',')
		.map((t) => t.trim())
		.filter((t) => t && t !== 'Online Meeting' && t !== "Chair's Choice")
		.map((t) => (Object.hasOwn(TYPE_MAP, t) ? TYPE_MAP[t] : t));
}

// Normalize North American phone numbers to E.164 (e.g. "+12045551234").
// Numbers that can't be confidently parsed are returned trimmed, unchanged.
function normalizePhone(raw: unknown): string | null {
	if (!raw || typeof raw !== 'string') return null;
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const digits = trimmed.replace(/\D/g, '');
	if (digits.length === 10) return `+1${digits}`;
	if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
	return trimmed;
}

// A meeting that meets in person must never disappear over address
// vagueness: TSML UI turns approximate="yes" into the Inactive shelf. In-person
// meetings therefore always feed "no"; "yes" is honored only for online ones.
function approximateFor(f: Fields): string | null {
	if (!f['conference-url']) return 'no';
	const explicit = (typeof f.approximate === 'string' ? f.approximate.trim() : '') || null;
	return explicit ?? (f.latitude && f.longitude ? 'no' : null);
}

function parseCoord(v: unknown): number | null {
	if (v === null || v === undefined) return null;
	const n = parseFloat(String(v));
	return Number.isNaN(n) ? null : n;
}

// Python `a or b` returns b when a is falsy (empty string included), so `||`
// is deliberate here, not `??`.
export function buildFeed(
	groups: WebflowItem[],
	meetings: WebflowItem[],
	dayOptions: DayOptions,
	today: string,
	includeDrafts: boolean
): FeedResult {
	const byId = new Map<string, WebflowItem>();
	for (const g of groups) byId.set(g.id, g);
	const rows: Record<string, unknown>[] = [];
	const skipped: Skipped[] = [];

	for (const m of meetings) {
		const fd: Fields = m.fieldData || {};
		const slug: string | null = fd.slug ?? null;
		if (m.isArchived || (m.isDraft && !includeDrafts) || fd['hide-from-meeting-finder']) continue;

		const g = typeof fd.group === 'string' ? byId.get(fd.group) : undefined;
		if (g === undefined) {
			skipped.push([slug, 'group missing']);
			continue;
		}
		const gf: Fields = g.fieldData || {};
		if (g.isArchived || (g.isDraft && !includeDrafts) || gf['hide-from-meeting-finder']) continue;

		const day =
			typeof fd.day === 'string' && Object.hasOwn(dayOptions, fd.day) ? dayOptions[fd.day] : undefined;
		if (day === undefined || !Object.hasOwn(DAY_MAP, day)) {
			skipped.push([slug, 'no day']);
			continue;
		}
		if (!inWindow(fd, today)) continue;

		let confUrl: string | null;
		let confNotes: string | null;
		if (fd['no-online-option']) {
			confUrl = null;
			confNotes = fd['conference-url-notes-override'] ?? null;
		} else {
			confUrl = (fd['conference-url-override'] || gf['conference-url']) ?? null;
			confNotes = (fd['conference-url-notes-override'] || gf['conference-url-notes']) ?? null;
		}
		const groupName: string | null = gf['hide-group-name'] ? null : (gf.name ?? null);
		const ml = m.lastUpdated || '';
		const gl = g.lastUpdated || '';
		const latest = (ml > gl ? ml : gl) || null;

		const row: Record<string, unknown> = {
			slug,
			name: (fd['display-name'] || gf.name) ?? null,
			day: DAY_MAP[day],
			time: fd['start-time'] ?? null,
			end_time: fd['end-time'] ?? null,
			timezone: gf.timezone || 'America/Winnipeg',
			types: mapTypes(fd.types),
			location: gf.location ?? null,
			formatted_address: gf.address ?? null,
			region: gf.region ?? null,
			sub_region: gf['sub-region'] ?? null,
			latitude: parseCoord(gf.latitude),
			longitude: parseCoord(gf.longitude),
			approximate: approximateFor({
				'conference-url': confUrl,
				approximate: gf.approximate,
				latitude: gf.latitude,
				longitude: gf.longitude
			}),
			notes: stripHtml(fd.notes) || null,
			location_notes: stripHtml(gf['location-notes']) || null,
			group: groupName,
			group_notes: stripHtml(gf['group-notes']) || null,
			url: gf.website ?? null,
			conference_url: confUrl,
			conference_url_notes: stripHtml(confNotes) || null,
			updated: toUpdatedTimestamp(latest)
		};
		if (gf.email || gf.phone) {
			row.entity = groupName;
			row.entity_email = gf.email ?? null;
			row.entity_phone = normalizePhone(gf.phone);
		}
		rows.push(row);
	}
	return { rows, skipped };
}
