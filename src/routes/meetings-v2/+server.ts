import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';
import { GROUPS_COLLECTION_ID, GROUP_MEETINGS_COLLECTION_ID, INCLUDE_DRAFTS } from '$lib/meetings-v2/config';
import { buildFeed, manitobaToday } from '$lib/meetings-v2/feed';
import { feedDeadline, getDayOptions, listAllItems } from '$lib/meetings-v2/webflow';

const SECURITY_HEADERS: Record<string, string> = {
	// CORS is set dynamically in src/hooks.server.ts after origin verification.
	// Keep only the static, non-Origin security headers here.
	'X-Content-Type-Options': 'nosniff',
	'X-Robots-Tag': 'noindex, nofollow',
	'Referrer-Policy': 'no-referrer'
};

const FEED_HEADERS: Record<string, string> = {
	...SECURITY_HEADERS,
	'Content-Type': 'application/json',
	// Cache for 5 minutes; serve stale for up to 60s while revalidating
	'Cache-Control': 'public, max-age=300, stale-while-revalidate=60'
};

// Per-instance only: a cold instance has none and falls through to 502.
let lastGoodBody: string | null = null;

export const OPTIONS: RequestHandler = () => {
	// OPTIONS is handled in src/hooks.server.ts after origin verification.
	// Returning 204 here too lets dev mode bypass the hook during local testing.
	return new Response(null, { status: 204, headers: SECURITY_HEADERS });
};

export const GET: RequestHandler = async () => {
	const token = env.WEBFLOW_V2_API_TOKEN || env.WEBFLOW_API_TOKEN;

	if (!token) {
		return new Response(JSON.stringify({ error: 'Server configuration error' }), {
			status: 500,
			headers: { ...SECURITY_HEADERS, 'Content-Type': 'application/json' }
		});
	}

	try {
		// One deadline for the whole build, so a slow Webflow fails it in time
		// for the fallback below to answer inside Netlify's function limit.
		const deadline = feedDeadline();
		const [groups, meetings, dayOptions] = await Promise.all([
			listAllItems(GROUPS_COLLECTION_ID, token, deadline),
			listAllItems(GROUP_MEETINGS_COLLECTION_ID, token, deadline),
			getDayOptions(GROUP_MEETINGS_COLLECTION_ID, token, deadline)
		]);
		const { rows, skipped } = buildFeed(groups, meetings, dayOptions, manitobaToday(), INCLUDE_DRAFTS);
		// Slug and reason only: meeting data must not reach the logs.
		for (const [slug, reason] of skipped) console.warn(`[meetings-v2] skipped ${slug}: ${reason}`);

		lastGoodBody = JSON.stringify(rows);
		return new Response(lastGoodBody, { status: 200, headers: FEED_HEADERS });
	} catch (err) {
		console.error('[meetings-v2] fetch failed:', err);
		if (lastGoodBody !== null) {
			return new Response(lastGoodBody, {
				status: 200,
				headers: { ...FEED_HEADERS, 'X-Feed-Stale': '1' }
			});
		}
		return new Response(JSON.stringify({ error: 'Failed to fetch meeting data' }), {
			status: 502,
			headers: { ...SECURITY_HEADERS, 'Content-Type': 'application/json' }
		});
	}
};
