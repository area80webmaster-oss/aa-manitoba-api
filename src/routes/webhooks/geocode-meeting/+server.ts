import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';

// Receives Webflow `collection_item_created` / `collection_item_changed`
// webhooks for the Meetings collection and fills Latitude/Longitude (plus
// approximate:"no" and the geocoded-address marker) from the Address field.
//
// Why: TSML UI treats a meeting as "approximate" — not in-person, and
// inactive when it also has no online link — whenever the address has fewer
// than 4 comma-separated parts and no explicit approximate value. Writing
// precise coordinates plus approximate:"no" overrides that guess, so an
// imperfectly formatted address no longer knocks a group off the map.
//
// Safety rules (mirrors scripts/geocode-meetings.mjs, which is the backfill
// and safety net behind this instant path):
//   • Requests must carry the shared secret (?token=…) the webhook was
//     registered with — Webflow has no signing for API-token webhooks.
//   • Only street-level geocoder matches are written; coarse matches leave
//     the item untouched and are logged for a human.
//   • Writes staged item data only — never publishes, never flips a draft.
//   • No-ops when Address equals geocoded-address, which is also what stops
//     the webhook fired by our own write from looping.
//   • Until GEOCODE_ALLOW=all, only draft items are written (staging rail).
//
// Gate outcomes return 200 so Webflow never retries or disables the webhook;
// only configuration errors return 5xx.

const MEETINGS_COLLECTION_ID = '6a101256165031ecf1106518';
const WEBFLOW_API_BASE = 'https://api.webflow.com/v2';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
// Manitoba venues: anything wider than ~2 km is a locality match, not a
// street address.
const MAX_BBOX_LAT_DEG = 0.02;
const MAX_BBOX_LON_DEG = 0.03;
// A road-only match (no house number found) is a guess along the whole
// street; only accept segments short enough (~400 m) that the midpoint is
// still a usable pin.
const MAX_ROAD_BBOX_LAT_DEG = 0.004;
const MAX_ROAD_BBOX_LON_DEG = 0.006;
// A community-only address (no street number) legitimately pins at the
// community itself — reserves and small towns often have no street grid.
// Big-city centroids stay rejected: a city name alone is not a venue.
const LOCALITY_ADDRESSTYPES = ['village', 'hamlet', 'town', 'city', 'municipality', 'suburb', 'neighbourhood', 'locality', 'isolated_dwelling'];
const MAX_LOCALITY_BBOX_LAT_DEG = 0.12;
const MAX_LOCALITY_BBOX_LON_DEG = 0.18;

const SECURITY_HEADERS: Record<string, string> = {
	'X-Content-Type-Options': 'nosniff',
	'X-Robots-Tag': 'noindex, nofollow',
	'Referrer-Policy': 'no-referrer'
};

type WebhookBody = {
	triggerType?: string;
	payload?: {
		id?: string;
		collectionId?: string;
		isArchived?: boolean;
		isDraft?: boolean;
		fieldData?: Record<string, unknown>;
	};
};

function json(status: number, body: Record<string, unknown>): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { ...SECURITY_HEADERS, 'Content-Type': 'application/json' }
	});
}

// Returns 5-decimal (~1.1 m) coordinates for an address-precise match, or
// null when the address can't be resolved precisely. Uses Google Geocoding
// when GOOGLE_MAPS_API_KEY is set (complete Canadian house-number data);
// otherwise falls back to Nominatim, whose OSM source is missing house
// numbers on many Winnipeg streets — those come back as road matches and
// are rejected rather than pinned kilometres off.
const HAS_HOUSE_NUMBER = /^\s*\d+[A-Za-z]?[\s,-]/;

type Coords = { latitude: string; longitude: string };

async function geocode(address: string): Promise<Coords | null> {
	return env.GOOGLE_MAPS_API_KEY ? geocodeGoogle(address) : geocodeNominatim(address);
}

async function geocodeGoogle(address: string): Promise<Coords | null> {
	const url =
		'https://maps.googleapis.com/maps/api/geocode/json' +
		`?address=${encodeURIComponent(address)}&components=country:CA&region=ca` +
		`&key=${env.GOOGLE_MAPS_API_KEY}`;
	const res = await fetch(url);
	if (!res.ok) throw new Error(`Google geocoder HTTP ${res.status}`);
	const data = (await res.json()) as {
		status?: string;
		error_message?: string;
		results?: Array<{
			types?: string[];
			geometry?: { location?: { lat: number; lng: number }; location_type?: string };
		}>;
	};
	if (data.status === 'ZERO_RESULTS') return null;
	if (data.status !== 'OK' || !data.results?.length) {
		throw new Error(`Google geocoder ${data.status}${data.error_message ? ` — ${data.error_message}` : ''}`);
	}

	const r = data.results[0];
	const locationType = r.geometry?.location_type;
	// ROOFTOP / RANGE_INTERPOLATED are address-precise. GEOMETRIC_CENTER is
	// only trusted when it centers an actual building or venue — for a route
	// or locality it is a guess along/inside it.
	const precise =
		locationType === 'ROOFTOP' ||
		locationType === 'RANGE_INTERPOLATED' ||
		(locationType === 'GEOMETRIC_CENTER' &&
			(r.types ?? []).some((t) =>
				['street_address', 'premise', 'subpremise', 'establishment', 'point_of_interest', 'church'].includes(t)
			));
	if (!precise || !r.geometry?.location) {
		console.log(`[geocode-meeting] rejected coarse match (${locationType} ${JSON.stringify(r.types ?? [])})`);
		return null;
	}

	return {
		latitude: r.geometry.location.lat.toFixed(5),
		longitude: r.geometry.location.lng.toFixed(5)
	};
}

async function geocodeNominatim(address: string): Promise<Coords | null> {
	const contact = env.GEOCODER_CONTACT || 'https://aamanitoba.org';
	const url = `${NOMINATIM}?format=jsonv2&limit=1&countrycodes=ca&q=${encodeURIComponent(address)}`;
	const res = await fetch(url, {
		headers: { 'User-Agent': `aa-manitoba-meetings-geocoder/1.0 (${contact})` }
	});
	if (!res.ok) throw new Error(`Nominatim ${res.status}: ${await res.text()}`);

	const results = (await res.json()) as Array<{
		lat?: string;
		lon?: string;
		category?: string;
		type?: string;
		addresstype?: string;
		display_name?: string;
		boundingbox?: string[];
	}>;
	if (!Array.isArray(results) || results.length === 0) return null;

	const r = results[0];
	const reject = (why: string): null => {
		console.log(
			`[geocode-meeting] rejected: ${why} (${r.category ?? '?'}/${r.type ?? '?'} "${r.display_name}")`
		);
		return null;
	};
	const [south, north, west, east] = (r.boundingbox ?? []).map(Number);
	if (![south, north, west, east].every(Number.isFinite)) return null;

	// A road match for a house-numbered query means the number wasn't found;
	// OSM roads are split into many short segments, so the returned segment
	// can sit kilometres from the actual building and its tiny bounding box
	// says nothing about accuracy.
	if (r.addresstype === 'road' || r.category === 'highway') {
		if (HAS_HOUSE_NUMBER.test(address)) return reject('street found but not the house number');
		if (north - south > MAX_ROAD_BBOX_LAT_DEG || east - west > MAX_ROAD_BBOX_LON_DEG) {
			return reject('road segment too long to pin');
		}
	} else if (LOCALITY_ADDRESSTYPES.includes(r.addresstype ?? '')) {
		if (HAS_HOUSE_NUMBER.test(address)) return reject('street address expected, got a locality');
		if (north - south > MAX_LOCALITY_BBOX_LAT_DEG || east - west > MAX_LOCALITY_BBOX_LON_DEG) {
			return reject('community too large to pin');
		}
	} else {
		if (['postcode', 'county', 'state'].includes(r.addresstype ?? '')) return reject('not a place');
		if (north - south > MAX_BBOX_LAT_DEG || east - west > MAX_BBOX_LON_DEG) {
			return reject('match too coarse');
		}
	}

	return {
		latitude: Number(r.lat).toFixed(5),
		longitude: Number(r.lon).toFixed(5)
	};
}

export const POST: RequestHandler = async ({ request, url }) => {
	const secret = env.GEOCODE_WEBHOOK_SECRET;
	const writeToken = env.WEBFLOW_WRITE_TOKEN;
	if (!secret || !writeToken) {
		console.error('[geocode-meeting] GEOCODE_WEBHOOK_SECRET / WEBFLOW_WRITE_TOKEN not configured');
		return json(503, { error: 'Not configured' });
	}
	if (url.searchParams.get('token') !== secret) {
		return json(401, { error: 'Unauthorized' });
	}

	let body: WebhookBody;
	try {
		body = (await request.json()) as WebhookBody;
	} catch {
		return json(400, { error: 'Invalid JSON' });
	}

	const item = body.payload;
	if (!item?.id || item.collectionId !== MEETINGS_COLLECTION_ID) {
		return json(200, { status: 'ignored', reason: 'not a Meetings item' });
	}
	if (item.isArchived) {
		return json(200, { status: 'ignored', reason: 'archived' });
	}
	if (env.GEOCODE_ALLOW !== 'all' && !item.isDraft) {
		return json(200, { status: 'ignored', reason: 'staging rail: drafts only' });
	}

	const fields = item.fieldData ?? {};
	const address = typeof fields.address === 'string' ? fields.address.trim() : '';
	const geocodedAddress =
		typeof fields['geocoded-address'] === 'string' ? fields['geocoded-address'].trim() : '';
	if (!address) {
		return json(200, { status: 'ignored', reason: 'no address' });
	}
	if (address === geocodedAddress) {
		return json(200, { status: 'up-to-date' });
	}
	// Pre-geocoder items carry hand-entered coordinates but no marker; this
	// event may be an unrelated field edit, so don't risk replacing better
	// coordinates. The sweep's STAMP_EXISTING migration clears this state.
	const latitude = typeof fields.latitude === 'string' ? fields.latitude.trim() : '';
	const longitude = typeof fields.longitude === 'string' ? fields.longitude.trim() : '';
	if (!geocodedAddress && latitude && longitude) {
		return json(200, { status: 'ignored', reason: 'unstamped legacy item' });
	}

	let coords: { latitude: string; longitude: string } | null;
	try {
		coords = await geocode(address);
	} catch (err) {
		console.error(`[geocode-meeting] geocoder error for ${item.id}:`, err);
		return json(200, { status: 'error', reason: 'geocoder unavailable' });
	}
	if (!coords) {
		console.log(`[geocode-meeting] unresolved address for ${item.id}: "${address}"`);
		return json(200, { status: 'unresolved' });
	}

	const patch = await fetch(`${WEBFLOW_API_BASE}/collections/${MEETINGS_COLLECTION_ID}/items/${item.id}`, {
		method: 'PATCH',
		headers: {
			Authorization: `Bearer ${writeToken}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			fieldData: {
				latitude: coords.latitude,
				longitude: coords.longitude,
				approximate: 'no',
				'geocoded-address': address
			}
		})
	});
	if (!patch.ok) {
		console.error(`[geocode-meeting] Webflow write failed for ${item.id}: ${patch.status} ${await patch.text()}`);
		return json(200, { status: 'error', reason: 'write failed' });
	}

	console.log(`[geocode-meeting] ${item.id} → ${coords.latitude}, ${coords.longitude}`);
	return json(200, { status: 'updated', ...coords });
};

export const GET: RequestHandler = () => json(405, { error: 'POST only' });
