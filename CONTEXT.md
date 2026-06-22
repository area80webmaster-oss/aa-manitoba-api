# AA Manitoba Meetings API

## Guardrails

| Rule | Why |
|------|-----|
| **Clear, not clever** | The agent builds exactly what's designed. No invented sections, copy, pages, or animations. Gaps and ambiguity = stop and ask, never guess. |
| **Variables & classes first** | All colour and type flow from theme variables and reusable classes so a single change cascades site-wide. No one-off hardcoded styles. |
| **Reuse before create** | Use the template's existing CMS collections, components, and classes before adding new ones. Extend, don't duplicate. (WET→DRY, Open/Closed.) |
| **One phase at a time** | Finish a phase, summarize, stop for review. Keeps the build reviewable and the agent's context tight. |
| **Live-site safety** | Never publish or push to the live/production domain. Build in the development only. Publish requires client consent + Justin's authorization. |


## Definition of Done
- [ ] An accessible API Endpoint that the public user can access.
- [ ] There are no loopholes or any security issues present with the the Svelte deployment.
- [ ] An endpoint that exposes only the JSON for the Meetings Guide App to use.

## Load Alongside

- `brand/engineering/principles.md` — engineering standard (reuse, no unnecessary abstraction, live-store/site safety)
- `brand/copywriting/conversion-page-framework.md` — only if the build includes writing or restructuring page copy (designs usually carry final copy)