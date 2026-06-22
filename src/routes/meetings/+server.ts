import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';

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

async function fetchAllMeetings(token: string): Promise<unknown[]> {
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
				}
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
		approximate: f.approximate ?? null,
		notes: stripHtml(f.notes) || null,
		location_notes: stripHtml(f['location-notes']) || null,
		group: f.group ?? null,
		group_notes: stripHtml(f['group-notes']) || null,
		url: f.website ?? null,
		conference_url: f['conference-url'] ?? null,
		conference_url_notes: stripHtml(f['conference-url-notes']) || null,
		updated: toUpdatedTimestamp(item.lastPublished as string)
	};

	// Contact persons
	if (f['contact-1-name'] || f['contact-1-email'] || f['contact-1-phone']) {
		meeting.contact_1_name = f['contact-1-name'] ?? null;
		meeting.contact_1_email = f['contact-1-email'] ?? null;
		meeting.contact_1_phone = normalizePhone(f['contact-1-phone']);
	}
	if (f['contact-2-name'] || f['contact-2-email'] || f['contact-2-phone']) {
		meeting.contact_2_name = f['contact-2-name'] ?? null;
		meeting.contact_2_email = f['contact-2-email'] ?? null;
		meeting.contact_2_phone = normalizePhone(f['contact-2-phone']);
	}
	if (f['contact-3-name'] || f['contact-3-email'] || f['contact-3-phone']) {
		meeting.contact_3_name = f['contact-3-name'] ?? null;
		meeting.contact_3_email = f['contact-3-email'] ?? null;
		meeting.contact_3_phone = normalizePhone(f['contact-3-phone']);
	}

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

export const GET: RequestHandler = async () => {
	const token = env.WEBFLOW_API_TOKEN;

	if (!token) {
		return new Response(JSON.stringify({ error: 'Server configuration error' }), {
			status: 500,
			headers: { ...SECURITY_HEADERS, 'Content-Type': 'application/json' }
		});
	}

	try {
		const raw = await fetchAllMeetings(token);
		const meetings = (raw as Record<string, unknown>[])
			.filter((item) => !item.isArchived && !item.isDraft)
			.map(transformMeeting);

		return new Response(JSON.stringify(meetings), {
			status: 200,
			headers: {
				...SECURITY_HEADERS,
				'Content-Type': 'application/json',
				// Cache for 5 minutes; serve stale for up to 60s while revalidating
				'Cache-Control': 'public, max-age=300, stale-while-revalidate=60'
			}
		});
	} catch (err) {
		console.error('[meetings] fetch failed:', err);
		return new Response(JSON.stringify({ error: 'Failed to fetch meeting data' }), {
			status: 502,
			headers: { ...SECURITY_HEADERS, 'Content-Type': 'application/json' }
		});
	}
};
