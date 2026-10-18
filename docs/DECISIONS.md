# Decisions log

Why things are the way they are. Newest at the bottom. Evidence first: rationale lives here so future agents do not re-litigate settled questions.

- 2026-10-18: Own build, not a fork. Mealie is AGPL-3.0; Tandoor is AGPL + Commons Clause (no selling). A fork would attach source-sharing strings to a future commercial product. We study their data models and build clean. (See SPEC "reverse-engineering notes".)
- 2026-10-18: Web is the recipe catalog, not a founder's recipe box. Users relate to their own tastes; the world's recipes are machine-readable via schema.org/Recipe JSON-LD. Import-on-demand per user; quality gate applied at import.
- 2026-10-18: Import legal posture: private user space + attribution + linkback; ingredient lists are facts, site prose is protected; no republishing. Licensed recipe APIs (Spoonacular/Edamam class) are the commercial-scale path, not v1.
- 2026-10-18: Conversational core: the chat is the app; five-to-six scoped agent tools; cards not forms. Rationale: the churn evidence says admin friction kills meal apps; conversation removes it.
- 2026-10-18: PWA-first shell (default, pending final sign-off): iPad/phone kitchen use, Wake Lock + Web Speech cover the kitchen cases, $0 build cost, no store fees until justified. Native (Expo) stays on the map for later.
- 2026-10-18: Pantry stores quantities + use-by dates, not booleans; freshness drives planning ("cook the chicken by Thursday").
- 2026-10-18: Component-prep + session scheduling are the wedge features no incumbent has; v1 uses greedy ordering, full CPM scheduler parked by design.
- 2026-10-18: Old Codex prototype (inkedintegration/-ashley-meal-prep) is reference only; its recipes were test data. Its pantry-matching concepts informed the schema; its code is not being ported wholesale.
- 2026-10-18 (night): Stack revision: vanilla JS PWA client + Supabase Edge Function, replacing the committed Vite/React scaffold. Evidence: no local Node toolchain in the build environment, static hosting path proven in this workspace, and v1 scope is chat + cards which vanilla handles cleanly. Revisit React only if the UI grows beyond chat + cards or a build step earns its keep.
- 2026-10-18 (night): The brain is one edge function (agent-chat): single-shot LLM intent parse then deterministic server-side tools (pantry dump, URL import with schema.org/Recipe extraction + chef-rubric scoring, profile updates). No multi-turn tool loop in v1: fewer failure modes, cheaper tokens, works across models. OpenRouter key lives only in function secrets. Free model fallback chain included.
- 2026-10-18 (night): Preview gate: soft shared token header (x-app-token) + RLS lockdown (no anon policies). Real accounts/auth deferred to a later milestone; do not expose the service role anywhere client-side.
