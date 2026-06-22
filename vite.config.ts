import adapter from '@sveltejs/adapter-netlify';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	server: {
		// Restrict to known tunnel domains. Add entries here if you switch tools (e.g. '.ngrok-free.app').
		allowedHosts: ['.loca.lt']
	},
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},

			// Netlify Functions deploy target. `edge` and `lambda` are the other options;
			// we want a long-running Node function so the Webflow token stays warm in memory.
			adapter: adapter({
				split: false
			})
		})
	]
});
