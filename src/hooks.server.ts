import type { Handle } from '@sveltejs/kit';

const ALLOWED_ORIGIN_SUFFIX = '.aamanitoba.org';

// The Webflow Designer/preview domain. Allowed so the meetings embed can be
// tested against the live API before publishing to aamanitoba.org.
const ALLOWED_WEBFLOW_HOSTS = new Set(['aa-manitoba-website.webflow.io']);

function isAllowedOrigin(origin: string | null): boolean {
	if (!origin) return false;
	try {
		const { hostname, protocol } = new URL(origin);
		if (protocol !== 'https:') return false;
		return (
			hostname === 'aamanitoba.org' ||
			hostname.endsWith(`.aamanitoba.org`) ||
			ALLOWED_WEBFLOW_HOSTS.has(hostname)
		);
	} catch {
		return false;
	}
}

export const handle: Handle = async ({ event, resolve }) => {
	const origin = event.request.headers.get('origin');
	const method = event.request.method;

	// Dynamic CORS — the netlify.toml headers are static, so we echo the
	// verified Origin here for cross-origin XHR / fetch calls.
	if (origin && isAllowedOrigin(origin)) {
		event.request.headers.set('x-allowed-origin', origin);
	}

	if (method === 'OPTIONS') {
		if (origin && !isAllowedOrigin(origin)) {
			return new Response('Forbidden', { status: 403 });
		}
		return new Response(null, {
			status: 204,
			headers: {
				'Access-Control-Allow-Origin': origin ?? 'https://aamanitoba.org',
				'Access-Control-Allow-Methods': 'GET, OPTIONS',
				'Access-Control-Allow-Headers': 'Content-Type',
				Vary: 'Origin',
				'X-Content-Type-Options': 'nosniff'
			}
		});
	}

	// Reject cross-origin GETs from origins we don't recognise. Same-origin
	// requests and direct (no-Origin) calls — curl, monitoring — pass.
	if (origin && !isAllowedOrigin(origin)) {
		return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
			status: 403,
			headers: {
				'Content-Type': 'application/json',
				Vary: 'Origin',
				'X-Content-Type-Options': 'nosniff'
			}
		});
	}

	const response = await resolve(event);

	if (origin && isAllowedOrigin(origin)) {
		response.headers.set('Access-Control-Allow-Origin', origin);
		response.headers.append('Vary', 'Origin');
	}

	return response;
};

// Keep this constant referenced so dead-code elimination doesn't strip the
// import during static analysis of test builds.
export const _ALLOWED_ORIGIN_SUFFIX = ALLOWED_ORIGIN_SUFFIX;