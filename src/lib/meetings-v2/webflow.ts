// Webflow CMS fetch layer for /meetings-v2. The token is a parameter so this
// module never touches env and stays importable from plain node tests.

const WEBFLOW_API_BASE = 'https://api.webflow.com/v2';
const PAGE_SIZE = 100;
const CONCURRENCY = 4;
// Netlify kills a synchronous function at 10 s. A cold, uncached build has to
// fail before that, or the route never reaches its serve-last-good / 502
// fallback and the caller just sees a platform timeout. So: one short retry
// on 429, 7 s per request, and one deadline shared by every fetch of a build.
export const MAX_RETRIES = 1;
const DEFAULT_RETRY_SECONDS = 2;
export const MAX_RETRY_SECONDS = 1;
export const REQUEST_TIMEOUT_MS = 7_000;
export const FETCH_DEADLINE_MS = 8_500;

// Absolute time (ms) after which a feed build gives up; pass the same value to
// every fetch of one build.
export function feedDeadline(now: number = Date.now()): number {
	return now + FETCH_DEADLINE_MS;
}

export interface WebflowListItem {
	id: string;
	isDraft?: boolean;
	isArchived?: boolean;
	lastUpdated?: string | null;
	fieldData?: Record<string, unknown> | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(res: Response): number {
	const raw = res.headers.get('retry-after');
	const seconds = raw !== null && raw.trim() !== '' ? Number(raw) : NaN;
	const chosen = Number.isFinite(seconds) && seconds >= 0 ? seconds : DEFAULT_RETRY_SECONDS;
	return Math.min(chosen, MAX_RETRY_SECONDS) * 1000;
}

async function getJson(url: string, token: string, deadline: number): Promise<unknown> {
	const where = url.split('?')[0];
	for (let attempt = 0; ; attempt++) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new Error(`Webflow fetch deadline passed before ${where}`);
		// The signal also bounds reading the body, so res.json() below is
		// covered by the same deadline.
		const res = await fetch(url, {
			headers: { Authorization: `Bearer ${token}`, 'accept-version': '1.0.0' },
			signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remaining))
		});
		if (res.status === 429 && attempt < MAX_RETRIES) {
			await res.body?.cancel();
			const wait = retryDelayMs(res);
			if (Date.now() + wait >= deadline) throw new Error(`Webflow API 429 for ${where}, no time left to retry`);
			await sleep(wait);
			continue;
		}
		if (!res.ok) {
			throw new Error(`Webflow API ${res.status} for ${where}`);
		}
		return res.json();
	}
}

function parsePage(data: unknown): { items: WebflowListItem[]; total: number } {
	if (!isRecord(data) || !Array.isArray(data.items)) {
		throw new Error('Webflow items response: items is not an array');
	}
	if (!isRecord(data.pagination) || typeof data.pagination.total !== 'number') {
		throw new Error('Webflow items response: pagination.total is not a number');
	}
	for (const item of data.items) {
		if (!isRecord(item) || typeof item.id !== 'string') {
			throw new Error('Webflow items response: item without a string id');
		}
	}
	return { items: data.items as WebflowListItem[], total: data.pagination.total };
}

export async function listAllItems(
	collectionId: string,
	token: string,
	deadline: number = feedDeadline()
): Promise<WebflowListItem[]> {
	const pageUrl = (offset: number) =>
		`${WEBFLOW_API_BASE}/collections/${collectionId}/items?limit=${PAGE_SIZE}&offset=${offset}`;

	const first = parsePage(await getJson(pageUrl(0), token, deadline));
	const offsets: number[] = [];
	for (let o = PAGE_SIZE; o < first.total; o += PAGE_SIZE) offsets.push(o);

	const pages: WebflowListItem[][] = new Array(offsets.length);
	let next = 0;
	const worker = async () => {
		while (next < offsets.length) {
			const i = next++;
			pages[i] = parsePage(await getJson(pageUrl(offsets[i]), token, deadline)).items;
		}
	};
	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, offsets.length) }, worker));

	// Pages are fetched while editors may be saving, so an item can shift
	// across a page boundary and appear twice; keep the first copy.
	const seen = new Set<string>();
	const all: WebflowListItem[] = [];
	for (const item of [...first.items, ...pages.flat()]) {
		if (seen.has(item.id)) continue;
		seen.add(item.id);
		all.push(item);
	}
	return all;
}

// Day is an Option field: items carry the option ID, the name only lives on
// the collection schema.
export async function getDayOptions(
	collectionId: string,
	token: string,
	deadline: number = feedDeadline()
): Promise<Record<string, string>> {
	const data = await getJson(`${WEBFLOW_API_BASE}/collections/${collectionId}`, token, deadline);
	if (!isRecord(data) || !Array.isArray(data.fields)) {
		throw new Error('Webflow collection response: fields is not an array');
	}
	const field = data.fields.find((f) => isRecord(f) && f.slug === 'day');
	if (!isRecord(field)) throw new Error("Webflow collection has no 'day' field");
	const options = isRecord(field.validations) ? field.validations.options : undefined;
	if (!Array.isArray(options)) throw new Error("Webflow 'day' field has no options");

	const out: Record<string, string> = {};
	for (const o of options) {
		if (!isRecord(o) || typeof o.id !== 'string' || typeof o.name !== 'string') {
			throw new Error("Webflow 'day' option without string id and name");
		}
		out[o.id] = o.name;
	}
	return out;
}
