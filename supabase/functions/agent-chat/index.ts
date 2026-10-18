// agent-chat: the chef brain, milestone 2.
// One public endpoint. Flow: chat text -> LLM intent parse (single shot) -> server-side tools.
// The OpenRouter key and the service role key never leave this function.
// v1 keeps the agent honest: parse -> act -> report. No silent magic, no fake data.

import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-app-token",
};

const DEFAULT_MODEL = Deno.env.get("OPENROUTER_MODEL") ?? "deepseek/deepseek-v4.1-flash-1017";
const FREE_FALLBACK_MODEL = "xingchen-agi/xing4.0-29b-a4b:free";
const ACCESS_TOKEN = Deno.env.get("APP_ACCESS_TOKEN") ?? "";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function fail(message: string, code = "error", status = 400) {
  return json({ error: code, message }, status);
}

async function callLLM(messages: { role: string; content: string }[]): Promise<string> {
  const key = Deno.env.get("OPENROUTER_API_KEY");
  if (!key) throw Object.assign(new Error("missing_key"), { code: "missing_key" });

  const models = [DEFAULT_MODEL, FREE_FALLBACK_MODEL];
  let lastErr: unknown = null;

  for (const model of models) {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: 2000,
        temperature: 0.3,
      }),
    });
    if (res.ok) {
      const data = await res.json();
      const text: string | undefined = data?.choices?.[0]?.message?.content;
      if (typeof text === "string" && text.trim()) return text;
      lastErr = new Error("empty_completion");
      continue;
    }
    // 402 = no credits, 404 = unknown model: fall through to the next model.
    if (res.status === 402 || res.status === 404 || res.status === 429) {
      lastErr = new Error(`model_${model}_status_${res.status}`);
      continue;
    }
    const detail = await res.text();
    throw Object.assign(new Error(`llm_${res.status}: ${detail.slice(0, 300)}`), { code: "llm_error" });
  }
  throw Object.assign(lastErr ?? new Error("llm_unavailable"), { code: "llm_unavailable" });
}

function parseJsonLoose(text: string): any | null {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function ensureHousehold(sb: ReturnType<typeof createClient>) {
  const { data } = await sb.from("households").select("id").limit(1);
  if (data && data.length > 0) return data[0].id as string;
  const { data: created, error } = await sb.from("households").insert({ name: "My kitchen" }).select("id").single();
  if (error) throw error;
  return created.id as string;
}

async function ensureProfile(sb: ReturnType<typeof createClient>, householdId: string) {
  const { data } = await sb.from("taste_profiles").select("*").eq("household_id", householdId).limit(1);
  if (data && data.length > 0) return data[0];
  const { data: created, error } = await sb.from("taste_profiles").insert({ household_id: householdId }).select("*").single();
  if (error) throw error;
  return created;
}

// ---------- tools ----------

async function toolPantryDump(sb: ReturnType<typeof createClient>, items: any[]) {
  const householdId = await ensureHousehold(sb);
  const rows = items
    .filter((i) => i && typeof i.raw_text === "string" && i.raw_text.trim())
    .slice(0, 60)
    .map((i) => ({
      household_id: householdId,
      raw_text: i.raw_text.trim(),
      quantity: typeof i.quantity === "number" ? i.quantity : null,
      source: "brain-dump",
      confirmed: false,
    }));
  if (rows.length === 0) return { card: null };
  const { data, error } = await sb.from("pantry_items").insert(rows).select("id, raw_text, quantity");
  if (error) throw error;
  return { card: { type: "pantry_review", items: data } };
}

async function toolSetProfile(sb: ReturnType<typeof createClient>, patch: Record<string, any>) {
  const householdId = await ensureHousehold(sb);
  await ensureProfile(sb, householdId);
  const allowed = [
    "dietary_restrictions", "allergies", "cuisines_loved", "cuisines_avoided",
    "disliked_ingredients", "household_size", "time_budget_minutes", "skill_level", "notes",
  ];
  const update: Record<string, any> = { updated_at: new Date().toISOString() };
  for (const k of allowed) if (k in patch) update[k] = patch[k];
  const { data, error } = await sb.from("taste_profiles")
    .update(update).eq("household_id", householdId).select("*").single();
  if (error) throw error;
  return { card: { type: "profile", profile: data } };
}

function isoDurationToMinutes(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const m = v.match(/^P(?!$)(\d+D)?(?:T(?=\d)([H]\d*)?([M]\d*)?)?$/i) || v.match(/PT?(\d+)([HM])/i);
  if (!m) {
    const plain = parseInt(v, 10);
    return Number.isFinite(plain) ? plain : null;
  }
  let minutes = 0;
  if (m[1]) minutes += parseInt(m[1]) * 24 * 60;
  if (m[2]) minutes += parseInt(m[2]) * (m[2].toLowerCase().includes("h") ? 60 : 1);
  return minutes || null;
}

function extractRecipeFromHtml(html: string): any | null {
  const blocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const candidates: any[] = [];
  for (const b of blocks) {
    try {
      const parsed = JSON.parse(b[1].trim());
      const queue = [parsed];
      while (queue.length) {
        const node = queue.pop();
        if (!node) continue;
        if (Array.isArray(node)) { queue.push(...node); continue; }
        if (typeof node !== "object") continue;
        const t = node["@type"];
        if (t === "Recipe" || (Array.isArray(t) && t.includes("Recipe"))) candidates.push(node);
        if (node["@graph"]) queue.push(node["@graph"]);
      }
    } catch {
      // tolerate broken JSON-LD blocks; keep scanning
    }
  }
  return candidates[0] ?? null;
}

function normalizeRecipe(r: any) {
  let steps: string[] = [];
  const ri = r.recipeInstructions;
  if (typeof ri === "string") {
    steps = ri.split(/\n+/).map((s: string) => s.trim()).filter(Boolean);
  } else if (Array.isArray(ri)) {
    for (const s of ri) {
      if (typeof s === "string") steps.push(s.trim());
      else if (s?.text) steps.push(String(s.text).trim());
      else if (s?.itemListElement) for (const e of s.itemListElement) {
        if (typeof e === "string") steps.push(e.trim());
        else if (e?.text) steps.push(String(e.text).trim());
        else if (e?.item?.text) steps.push(String(e.item.text).trim());
      }
    }
  }
  const ingredients: string[] = Array.isArray(r.recipeIngredient)
    ? r.recipeIngredient.map((x: unknown) => String(x).trim()).filter(Boolean)
    : [];
  const sourceUrl = typeof r.mainEntityOfPage === "string" ? r.mainEntityOfPage : (r.url ?? "");
  return {
    title: String(r.name ?? "").trim(),
    servings: parseFloat(r.recipeYield ?? "") || null,
    prep_minutes: isoDurationToMinutes(r.prepTime),
    cook_minutes: isoDurationToMinutes(r.cookTime),
    cuisine: Array.isArray(r.recipeCuisine) ? String(r.recipeCuisine[0] ?? "") : (r.recipeCuisine ?? ""),
    image: typeof r.image === "string" ? r.image : (Array.isArray(r.image) ? (typeof r.image[0] === "string" ? r.image[0] : r.image[0]?.url) : null),
    author: r.author?.name ?? r.author ?? r.publisher?.name ?? null,
    ingredients,
    steps,
    sourceUrl,
  };
}

async function toolImportRecipe(sb: ReturnType<typeof createClient>, url: string) {
  if (!/^https?:\/\//i.test(url)) return { error: "bad_url", message: "That does not look like a recipe URL." };
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; MealPrepAI/0.1; personal recipe vault importer)" },
  });
  if (!res.ok) return { error: "fetch_failed", message: `Could not reach that page (status ${res.status}).` };
  const html = await res.text();
  const raw = extractRecipeFromHtml(html);
  if (!raw) {
    return {
      error: "no_recipe_schema",
      message: "No structured recipe found there. Many big sites publish it; small personal blogs sometimes do not. Try another URL or paste the ingredients and steps as text.",
    };
  }
  const n = normalizeRecipe(raw);
  if (!n.title || n.ingredients.length === 0 || n.steps.length === 0) {
    return { error: "partial_recipe", message: "Found a recipe but it looks incomplete (missing title, ingredients, or steps)." };
  }

  // Chef-rubric quality gate: one LLM pass that scores and normalizes.
  const rubricPrompt = `You are an experienced chef reviewing a recipe imported from the web for a meal-prep app. Reply ONLY with JSON:
{"quality_score": 0-100, "quality_notes": ["short honest notes"], "component_flags": ["protein","starch","veg","sauce","dish"] up to 2, "steps": [{"text": "cleaned instruction", "kind": "active"|"passive", "minutes": estimate_int_or_null, "equipment": "oven|burner|instant pot|blender|none..."}], "servings": number_or_null}
Scoring guide: 80+ = steps hold together and quantities are sane; 60-79 = workable but rough (note what is off); below 60 = broken (vague steps, impossible timing). Clean up noisy step text but keep every real instruction. Passive means mostly waiting (chill, rest, marinate, slow bake) while you can do other tasks.
RECIPE:
title: ${n.title}
servings: ${n.servings ?? "?"}
ingredients: ${JSON.stringify(n.ingredients)}
steps: ${JSON.stringify(n.steps)}`;

  let scored: any = null;
  try {
    const out = await callLLM([
      { role: "system", content: "Reply with valid JSON only. No prose, no markdown fences." },
      { role: "user", content: rubricPrompt },
    ]);
    scored = parseJsonLoose(out);
  } catch {
    // LLM unavailable: still store the recipe honestly, un-scored.
  }

  const householdId = await ensureHousehold(sb);
  const origin = new URL(url).hostname.replace(/^www\./, "");
  const { data: recipe, error } = await sb.from("recipes").insert({
    household_id: householdId,
    title: n.title,
    source_url: url,
    source_name: origin,
    attribution: n.author ? `${n.author} · ${origin}` : origin,
    status: "imported",
    quality_score: typeof scored?.quality_score === "number" ? scored.quality_score : null,
    quality_notes: Array.isArray(scored?.quality_notes) ? scored.quality_notes : [],
    servings: scored?.servings ?? n.servings,
    component_flags: Array.isArray(scored?.component_flags) ? scored.component_flags : ["dish"],
    prep_minutes: n.prep_minutes,
    cook_minutes: n.cook_minutes,
    cuisine: (typeof scored?.cuisine === "string" && scored.cuisine) || n.cuisine || null,
    image_url: n.image,
    imported_at: new Date().toISOString(),
  }).select("*").single();
  if (error) throw error;

  const ingRows = n.ingredients.map((raw: string, i: number) => ({ recipe_id: recipe.id, raw_text: raw, position: i }));
  const stepRows = (Array.isArray(scored?.steps) && scored.steps.length > 0 ? scored.steps : n.steps.map((text: string) => ({ text, kind: "active", minutes: null })))
    .slice(0, 40)
    .map((s: any, i: number) => ({
      recipe_id: recipe.id,
      position: i + 1,
      text: String(s.text ?? "").trim(),
      kind: s.kind === "passive" ? "passive" : "active",
      minutes: typeof s.minutes === "number" ? s.minutes : null,
      equipment: typeof s.equipment === "string" && s.equipment !== "none" ? s.equipment : null,
    }))
    .filter((s: any) => s.text);
  if (ingRows.length) await sb.from("recipe_ingredients").insert(ingRows);
  if (stepRows.length) await sb.from("recipe_steps").insert(stepRows);

  return {
    card: {
      type: "recipe",
      recipe: {
        id: recipe.id,
        title: recipe.title,
        attribution: recipe.attribution,
        source_url: url,
        quality_score: recipe.quality_score,
        quality_notes: recipe.quality_notes,
        servings: recipe.servings,
        ingredients_count: ingRows.length,
        steps_count: stepRows.length,
      },
    },
  };
}

// ---------- intent prompt ----------

const SYSTEM = `You are the intent parser inside a calm, conversational meal-prep app. The user is talking to their kitchen.
Reply ONLY with JSON, no markdown, no prose:
{"intent": "chat"|"pantry_dump"|"import_recipe"|"plan_week"|"set_profile",
 "reply": "a warm, brief reply to the user (1-3 sentences, required for chat, optional otherwise)",
 "items": [{"raw_text": "ingredient as stated", "quantity": number_or_null, "unit": string_or_null}],
 "url": "recipe url",
 "profile_patch": {}}
Rules:
- pantry_dump when the user lists food they have (fridge dump, shopping haul, "I have chicken, rice...").
- import_recipe when the user shares a recipe URL they want saved.
- set_profile when they say things like "we are vegetarian", "no dairy", "household of 3", "love thai", "hate cilantro", "45 minutes sundays". Map: dietary_restrictions[] (lowercase, e.g. vegetarian, dairy-free, gluten-free, halal, kosher), allergies[], cuisines_loved[], cuisines_avoided[], disliked_ingredients[], household_size (int), time_budget_minutes (int), notes (anything else useful, e.g. "two kids, one picky").
- plan_week when they ask you to plan the week or meals.
- otherwise chat.
- Keep "reply" warm and human, never say you are an AI language model.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return fail("POST only", "bad_method", 405);

  const token = req.headers.get("x-app-token") ?? "";
  if (ACCESS_TOKEN && token !== ACCESS_TOKEN) return fail("Unauthorized", "unauthorized", 401);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return fail("Send JSON: { messages: [...] }", "bad_json");
  }
  const userText = String(body?.message ?? "").trim();
  if (!userText) return fail("Empty message", "empty_message");

  const sb = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  try {
    let parsed: any = null;
    try {
      const out = await callLLM([
        { role: "system", content: SYSTEM },
        { role: "user", content: userText },
      ]);
      parsed = parseJsonLoose(out);
    } catch (e: any) {
      if (e?.code === "missing_key") {
        return fail("The OpenRouter key is not set for this project yet. Add OPENROUTER_API_KEY under Edge Function secrets, then try again.", "missing_key", 503);
      }
      throw e;
    }

    if (!parsed || typeof parsed.intent !== "string") {
      return json({ reply: "Hmm, I lost the thread there for a second. Say that again?", cards: [] });
    }

    switch (parsed.intent) {
      case "pantry_dump": {
        const items = Array.isArray(parsed.items) ? parsed.items : [{ raw_text: userText }];
        const { card } = await toolPantryDump(sb, items);
        return json({ reply: parsed.reply ?? "Got it. Here is what I caught; anything missing?", cards: card ? [card] : [] });
      }
      case "import_recipe": {
        const url = typeof parsed.url === "string" ? parsed.url : (userText.match(/https?:\/\/\S+/)?.[0] ?? "");
        const result = await toolImportRecipe(sb, url);
        if (result.error) return json({ reply: parsed.reply ?? result.message, cards: [], error: result.error });
        return json({ reply: parsed.reply ?? "Saved. Here is what I imported:", cards: [result.card] });
      }
      case "set_profile": {
        const { card } = await toolSetProfile(sb, parsed.profile_patch ?? {});
        return json({ reply: parsed.reply ?? "Noted. I will cook around that.", cards: [card] });
      }
      case "plan_week": {
        return json({
          reply: parsed.reply ?? "The one-tap week lands in milestone 3. For now: stock the pantry and drop in a recipe link or two, and I will be ready.",
          cards: [{ type: "plan_stub" }],
        });
      }
      default:
        return json({ reply: parsed.reply ?? "Right there with you.", cards: [] });
    }
  } catch (e: any) {
    console.error("agent-chat error", e?.message ?? e);
    return fail("Something broke in the kitchen. The details are in the function logs.", "server_error", 500);
  }
});
