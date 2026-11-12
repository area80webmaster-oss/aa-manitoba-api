// Webflow CMS fetch layer for /meetings-v2. The token is a parameter so this
// module never touches env and stays importable from plain node tests.

const WEBFLOW_API_BASE = 'https://api.webflow.com/v2';
const PAGE_SIZE = 100;
const CONCURRENCY = 4;
const MAX_RETRIES = 3;
const DEFAULT_RETRY_SECONDS = 2;
const MAX_RETRY_SECONDS = 10;
// A hung Webflow call must not hold the function open until Netlify kills it,
// because that would skip the serve-last-good fallback.
const REQUEST_TIMEOUT_MS = 20_000;

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

async function getJson(url: string, token: string): Promise<unknown> {
	for (let attempt = 0; ; attempt++) {
		const res = await fetch(url, {
			headers: { Authorization: `Bearer ${token}`, 'accept-version': '1.0.0' },
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
		});
		if (res.status === 429 && attempt < MAX_RETRIES) {
			await res.body?.cancel();
			await sleep(retryDelayMs(res));
			continue;
		}
		if (!res.ok) {
			throw new Error(`Webflow API ${res.status} for ${url.split('?')[0]}`);
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

export async function listAllItems(collectionId: string, token: string): Promise<WebflowListItem[]> {
	const pageUrl = (offset: number) =>
		`${WEBFLOW_API_BASE}/collections/${collectionId}/items?limit=${PAGE_SIZE}&offset=${offset}`;

	const first = parsePage(await getJson(pageUrl(0), token));
	const offsets: number[] = [];
	for (let o = PAGE_SIZE; o < first.total; o += PAGE_SIZE) offsets.push(o);

	const pages: WebflowListItem[][] = new Array(offsets.length);
	let next = 0;
	const worker = async () => {
		while (next < offsets.length) {
			const i = next++;
			pages[i] = parsePage(await getJson(pageUrl(offsets[i]), token)).items;
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
	token: string
): Promise<Record<string, string>> {
	const data = await getJson(`${WEBFLOW_API_BASE}/collections/${collectionId}`, token);
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
