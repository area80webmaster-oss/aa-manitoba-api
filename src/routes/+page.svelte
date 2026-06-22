<svelte:head>
	<title>AA Manitoba Meetings API</title>
</svelte:head>

<main>
	<h1>AA Manitoba Meetings API</h1>
	<p>
		Meeting data is available at <a href="/meetings"><code>/meetings</code></a>.
	</p>
	<p>Returns JSON — all published AA Manitoba meetings from Webflow CMS.</p>
</main>

<style>
	main {
		font-family: system-ui, sans-serif;
		max-width: 480px;
		margin: 4rem auto;
		padding: 0 1.5rem;
		color: #111;
	}

	h1 {
		font-size: 1.5rem;
		margin-bottom: 1rem;
	}

	p {
		color: #444;
		line-height: 1.6;
	}

	code {
		background: #f3f3f3;
		padding: 0.1em 0.4em;
		border-radius: 3px;
		font-size: 0.9em;
	}
</style>
