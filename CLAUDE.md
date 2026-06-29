# AA Manitoba Meetings API

**Type:** SvelteKit API (Netlify Functions)
**Stack:** SvelteKit 2, Svelte 5 (runes), TypeScript, Vite
**Runtime:** Node.js LTS + pnpm

## What This Is

A single-endpoint SvelteKit service that reads the AA Manitoba meetings Webflow CMS
collection and exposes it as a public JSON feed (`/meetings`) in the
code4recovery / Meetings Guide spec, for consumption by the Meetings Guide app.
Deployed as a long-running Netlify Function.

---

## Engineering Principles

These apply to every file touched in this project.

| Principle | Rule |
|-----------|------|
| Separation of concerns | One module, one reason to change |
| No side effects at the core | Pure logic in the middle, IO/network/DB/filesystem only at the edges |
| Open/Closed | Extend by adding — modify existing code only to fix bugs, never for a new caller |
| WET before DRY | Duplicate until three identical-shape instances, then extract |
| No unnecessary abstraction | If you can delete it and nothing breaks, delete it |
| Boundary validation only | Validate user input and external API responses — trust internal code |
| Comments explain WHY | Not what. Never describe what the code does. |

---

## Project Structure

```
.
├── src/
│   ├── app.d.ts             # SvelteKit ambient types
│   ├── app.html             # HTML shell
│   ├── hooks.server.ts      # Origin verification + dynamic CORS
│   ├── lib/                 # Shared code ($lib)
│   └── routes/
│       ├── +layout.svelte
│       ├── +page.svelte     # Landing page
│       └── meetings/+server.ts   # The JSON feed endpoint
├── static/                  # Served as-is (robots.txt)
├── netlify.toml             # Deploy + static headers config
├── vite.config.ts           # Netlify adapter (split: false)
└── tsconfig.json
```

**Entry point:** `src/routes/meetings/+server.ts` (the public feed); request gate in `src/hooks.server.ts`
**Build output:** `.svelte-kit/` and Netlify function bundle — generated, never edit directly

---

## Conventions

- Server route handlers are `+server.ts` files exporting `GET`/`OPTIONS` etc.; one folder per endpoint under `src/routes/`
- Read secrets via `$env/dynamic/private` (e.g. `env.WEBFLOW_API_TOKEN`) — never hardcode tokens or the Webflow collection ID into new callers
- Validate external API responses (Webflow) at the fetch boundary; transform functions are pure (typed in, typed out)
- CORS/origin policy lives only in `src/hooks.server.ts` — allow `aamanitoba.org` and `*.aamanitoba.org` over HTTPS; don't scatter origin checks into routes
- Svelte 5 runes mode is forced for project files — write runes, not legacy reactive syntax
- Always set the static security headers (`X-Content-Type-Options`, `X-Robots-Tag`, `Referrer-Policy`) on JSON responses; keep cache headers on the feed
- Shared helpers go in `src/lib/` and import via the `$lib` alias

---

## Workflow

| Task | Command |
|------|---------|
| Dev | `pnpm dev` |
| Type check | `pnpm check` |
| Build | `pnpm build` |
| Preview | `pnpm preview` |

---

## External Services

- **Webflow CMS API v2** — source of meeting data; read-only via `WEBFLOW_API_TOKEN` (scope `CMS:read`). Collection paginated 100/page.
- **Netlify** — hosting; deploys the SvelteKit build as a single long-running Node function (`netlify.toml`, `@sveltejs/adapter-netlify`).

---

## Package Security

- Never install a package younger than 14 days — let the community catch malicious releases first.
- Read every install command before approving the dependencies it pulls in.

---

## Agent Behavior

- **Never ask the user to test, run, or verify anything.** Claude owns the full dev loop — write, run, debug, fix, repeat until it works.
- If something genuinely cannot be verified (e.g. a visual UI state), say so explicitly. Never claim success without verifying.
- **Destructive commands require confirmation first.** Destructive = force push, `reset --hard`, deleting files/branches, dropping tables, removing packages, overwriting uncommitted work.
- **Live-site safety.** Never publish or push to the production domain without explicit authorization — develop against dev/preview only.
- Everything else: just run it. For complex or non-obvious commands, give one line of context — then run without waiting.

---

## Do Not Touch

- `.svelte-kit/` and the Netlify function bundle — generated output, never edit directly
- `.env` / `.env.*` — never read or write secret values; use `.env.example` for shape only
- `pnpm-lock.yaml` — source of truth, never edit manually
- `node_modules/` — never edit
