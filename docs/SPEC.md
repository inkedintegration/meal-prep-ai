# Meal plan app: v1 spec + reverse-engineering notes

*Drafted Oct 18, 2026. Working title pending. Status: spec for Ashley's approval; nothing built yet.*

## The thesis

Existing meal-prep apps overwhelm. They hand you a recipe database and make you do the planning, the entry, the cross-referencing. The vision, in Ashley's words: **ChatGPT/Claude for meal prepping and curation**. The conversation is the app. You talk, it curates, and the week plan, the shopping list, and the cook-day guide fall out as artifacts. Calm by default, zero forms.

Market tailwind: the incumbent generation is dying (Mealime shut down Oct 21, 2026; Yummly discontinued 2024; PlateJoy closed), open-source AI experiments are weeks old with double-digit stars, and no one has shipped a conversation-first, chef-quality version. The gap is real.

## Sourcing: the web is the recipe database (not Ashley's kitchen)

Users do not relate to one person's recipe box, and no single person can cover every cuisine, restriction, and craving worldwide. So the catalog is the open web, matched to each user's taste:

- Most recipe sites publish schema.org/Recipe JSON-LD for machines (that is how Google recipe search works). An import pipeline can pull structured ingredients, steps, times, yields, and images from almost any recipe URL.
- Established, years-old tools (Paprika, Mealie) prove users accept URL-import as normal behavior.
- Coverage grows on demand: the agent finds candidate recipes anywhere on the web, imports the best matches, and the vault fills itself per user. No giant pre-built database needed for v1.
- Ashley's own recipes become the founder's trusted examples and the quality benchmark, not the catalog.

**The legal line (honest version):** ingredient lists are facts and not copyrightable; site prose (headnotes, story text) is creative work. The safe posture, same as Paprika/Mealie: import into the user's private space with attribution and a link back to the source, never republish a site's full prose publicly, respect robots.txt and rate limits. When the product goes commercial at scale, graduate to licensed recipe APIs (Spoonacular/Edamam-style) or direct partnerships. v1 stays personal-use import and this costs nothing.

## What the Mealie study taught us (ideas only, no code copied)

Mealie (13.6k stars, AGPL-3.0) is the best open reference. From reading its data models:

1. **Canonical foods + units with alias tables.** "chicken breasts", "2 chicken breast", "chicken" all resolve to one canonical food; units carry abbreviations, plurals, aliases. The LLM does this normalization at entry time; canonical tables keep the data clean afterwards.
2. **Shopping-list provenance.** Every list item remembers which recipe(s) and what scale contributed it, so quantities merge across recipes and removing a meal cleanly removes its contributions.
3. **Plan rules exist but are dumb.** Mealie's auto-planning is tag/category filters per weekday. No AI, no pantry awareness, no freshness logic. Our conversational agent lives in that gap.
4. **Pantry is a boolean.** Mealie tracks "on hand" as a flag per food. Ours needs quantities and rough freshness dates, because "cook the chicken by Thursday" is the product.
5. **Servings math everywhere.** Meal plans carry a recipe scale; every plan-to-list flow multiplies through it.
6. **Substitutions exist but are manual.** Mealie has substitution records on ingredients; ours become AI-driven and taste-aware.

## The product stance: curation over generation, at web scale

A chat app for food is only trustworthy if it never invents a bad recipe. Two layers keep that promise:

- **The vault is web-sourced.** The agent curates real, published recipes matched to the user's taste profile and restrictions; every import keeps its source link and attribution.
- **A chef-rubric quality gate.** Every imported recipe gets scored: do the steps hold together, are quantities sane, does the timing survive contact with a real kitchen (Ashley's lens). Low scores get parked, not shown. Generation fills gaps only as clearly-labeled drafts until they earn trust.

That is what "curation" means here: the AI curates the world's recipes like a chef, with the user's taste, not like a random generator.

## v1 domain model (simplified, ours)

- **TasteProfile**: dietary restrictions (hard filters: allergies, vegetarian, halal/kosher, etc.), cuisines loved and avoided, disliked ingredients, household size, time budget per cook day, skill level
- **Ingredient** (canonical food, AI-merged aliases) + **Unit** (few, normalized) + **Substitution** pairs (validated by food logic, not vibes)
- **Recipe**: title, servings, source URL + attribution, component flags (protein / starch / veg / sauce / full dish), ingredient lines, steps tagged active or passive with equipment + rough minutes, shelf-life class (eat-fresh / keeps 3-4 days / freezer-friendly), quality score, status (imported / tested / draft)
- **PantryItem**: ingredient, quantity, unit, added date, optional use-by
- **WeekPlan**: meal pool, not calendar-locked; optional day hints; entries = recipe or component pairing + servings
- **PrepSession**: generated task list (order + parallel hints + timers) from selected recipes
- **ShoppingList**: merged quantities, aisle grouping, provenance back to recipes
- **Household**: single-user in v1; schema leaves room for shared households later

## The conversational core (v1 product flow)

One chat thread plus rendered cards. The agent has a small set of tools it calls behind the scenes; the user only sees calm cards and short replies.

1. **Onboard by conversation**: "no dairy, love Thai and Mediterranean, two kids, 45 minutes on Sundays" becomes the taste profile; it can be edited in plain words forever after.
2. **Brain-dump**: send a photo of the fridge, a rambling voice note, or messy text; the agent structures it into pantry items and shows a review card.
3. **"Plan my week"**: the agent finds and imports web recipes that fit the profile and the pantry, proposes the week as a week card, and swaps in plain words when asked.
4. **Gap list**: shopping list covers only what's missing, merged and grouped; substitutions offered where something is pricey or out of season.
5. **Cook day**: "walk me through Sunday" produces the session card: ordered tasks, parallel hints, timers.

## v1 scope (the knife-edge cut)

In: web app installable as a PWA (iPad/phone kitchen-friendly), single user, one chat thread, agent with 6 scoped tools (profile, pantry, vault + import, plan, list, session), URL import with quality scoring, agent-driven web recipe discovery matched to the taste profile, review cards before anything saves, guided prep session with simple task ordering + timers.

Out for v1 (parked, on the map): multi-user households, video/social recipe import, grocery delivery APIs, subscriptions/payments, native app stores, the full CPM optimizer (v1 uses greedy ordering), licensed recipe APIs (commercial-phase move).

## Stack recommendation

- **Frontend**: React + Vite PWA (or Next.js later if server rendering earns its keep). Mobile-first layout, big touch targets, high contrast for kitchen use. Wake Lock + Web Speech cover keep-screen-on and hands-free without app stores.
- **Backend/data**: Supabase free tier (Postgres, auth when needed, storage for photos).
- **AI**: agent loop with scoped tools over one LLM; start cheap, design a single `ai` module so providers can swap.
- **Repo**: new private repo on GitHub under inkedintegration; Mealie stays a read-only reference.
- Cost profile: $0/month during build; no app-store fee until there's a reason.

## Build order (first three milestones)

1. **Skeleton with a spine**: repo, DB schema (including taste profile + recipe provenance), recipe + pantry CRUD behind simple screens, deployable preview URL.
2. **The chef brain**: chat thread working end to end: brain-dump pantry, paste a recipe URL, watch it import, normalize, and score. The wow moment.
3. **The one-tap week**: web discovery + plan tool + week card, then the gap list.

## Open decisions for Ashley

- App name/working title (chat has options; her call whenever)
- Stack: Juno's default is PWA-first unless she says otherwise
- Onboarding questions the taste profile asks on day one
