import type { Handle } from '@sveltejs/kit';

// The feed is public, read-only meeting data published in the code4recovery
// spec. CORS is a browser-only mechanism and provides no security for public
// data — anyone can curl it — so we allow any origin and let third-party
// consumers fetch via browser AJAX. If access ever needs restricting, that
// must come from a token check, not from CORS.
//
// CORS lives ONLY here. Do not also set Access-Control-* in netlify.toml:
// Netlify applies static header rules on top of the function response, and a
// second Access-Control-Allow-Origin produces a duplicate header that browsers
// reject ("contains multiple values").
const CORS_HEADERS: Record<string, string> = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type'
};

export const handle: Handle = async ({ event, resolve }) => {
	if (event.request.method === 'OPTIONS') {
		return new Response(null, {
			status: 204,
			headers: { ...CORS_HEADERS, 'X-Content-Type-Options': 'nosniff' }
		});
	}

	const response = await resolve(event);
	for (const [key, value] of Object.entries(CORS_HEADERS)) {
		response.headers.set(key, value);
	}
	return response;
};
