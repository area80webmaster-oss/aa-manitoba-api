import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';

const WEBFLOW_API_BASE = 'https://api.webflow.com/v2';
const COLLECTION_ID = '6a156a1f0ac578734e57693d';

// Webflow Option fields serialize as the option's ID in fieldData (not the
// display name), so we map them back to the human label the calendar groups and
// colour-codes by. Keep these names byte-for-byte in sync with the Category
// option list in the Events CMS collection.
const CATEGORY_MAP: Record<string, string> = {
	'9d4dc75a24c6d276e552f740978f97d1': 'Winnipeg Intergroup Committee',
	'609bb06140e14309ce263c7df726b070': 'TAS',
	'51a4117b41cd94dea68ade182850f84a': 'Area 80 Events',
	'e7f451938139ed36c655d4072ed5002c': 'Neighbouring Area Events',
	'521e69e4b85b01195ab0bc7e7eb83c0c': 'Manitoba Central Office/Intergroup',
	'f9afe06117289fc8b114c096482e6893': 'Area 80 Assemblies and Service Committee Meetings',
	'7ee905fb25f8f58811e14107d0feb962': 'Westman Intergroup',
	'584b2121eabea5edfdb46f06f33589ca': 'Main'
};

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type',
	'X-Content-Type-Options': 'nosniff',
	'X-Robots-Tag': 'noindex, nofollow'
};

async function fetchAllItems(token: string): Promise<unknown[]> {
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

function transformEvent(item: Record<string, unknown>): Record<string, unknown> {
	const f = item.fieldData as Record<string, unknown>;
	const categoryId = (f.category as string) ?? null;

	return {
		name: (f.name as string) ?? null,
		slug: (f.slug as string) ?? null,
		// ISO-8601 UTC strings — FullCalendar parses these directly.
		start: (f['start-date-time'] as string) ?? null,
		end: (f['end-date-time'] as string) ?? null,
		all_day: f['all-day'] === true,
		// Pass the human-readable category name through; the calendar slugifies it
		// itself for colour-coding and filter pills. Unknown IDs fall back to the
		// raw value so they stay visible rather than silently dropping.
		category: categoryId ? (CATEGORY_MAP[categoryId] ?? categoryId) : null,
		short_description: (f['short-description'] as string) ?? null
	};
}

export const OPTIONS: RequestHandler = () => {
	return new Response(null, { status: 204, headers: CORS_HEADERS });
};

export const GET: RequestHandler = async () => {
	const token = env.WEBFLOW_API_TOKEN;

	if (!token) {
		return new Response(JSON.stringify({ error: 'Server configuration error' }), {
			status: 500,
			headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
		});
	}

	try {
		const raw = await fetchAllItems(token);
		const events = (raw as Record<string, unknown>[])
			.filter((item) => !item.isArchived && !item.isDraft)
			.map(transformEvent);

		return new Response(JSON.stringify(events), {
			status: 200,
			headers: {
				...CORS_HEADERS,
				'Content-Type': 'application/json',
				// Cache for 5 minutes; serve stale for up to 60s while revalidating
				'Cache-Control': 'public, max-age=300, stale-while-revalidate=60'
			}
		});
	} catch (err) {
		console.error('[events] fetch failed:', err);
		return new Response(JSON.stringify({ error: 'Failed to fetch event data' }), {
			status: 502,
			headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
		});
	}
};
