# Meal prep AI (working name)

Conversation-first meal prep and curation. You talk, it curates: the week plan, the shopping list, and the cook-day guide fall out as artifacts. Calm by default, zero forms.

**Thesis:** existing meal-prep apps overwhelm because they make you do the planning and the entry. The catalog is the open web, matched to each user's taste profile; an AI agent curates like a chef and never invents untested recipes (imports carry attribution; generated ideas stay drafts until they earn trust).

Read `docs/SPEC.md` first. Rationale lives in `docs/DECISIONS.md`.

## Layout

- `client/` : vanilla PWA (chat + cards). `config.example.js` shows the wiring.
- `supabase/functions/agent-chat/` : the chef brain (edge function, Deno). Holds the OpenRouter key; everything server-side.
- `db/` : schema + RLS policies.

## Ground rules

- Clean-room: concepts may come from studying open-source meal apps (Mealie et al.), no code copied.
- Recipe content is imported into private user space with attribution and linkback; no republishing of site prose.
- v1 is a single-user PWA; $0/month during build; nothing monetized yet.
- The OpenRouter key never goes in the client. Client embeds only the Supabase anon key + a soft gate token.
