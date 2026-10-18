// agent-chat: the chef brain, milestone 2 (v2: multi-part parsing).
// One public endpoint. Flow: chat text -> single-shot LLM parse into parts -> server-side tools.
// The OpenRouter key and the service role key never leave this function.
// Golden fixture: tests/fixtures/real-week-prep-001.md. Any prompt change gets checked against it.

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
        max_tokens: 3000,
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
    // 402 = no credits, 404 = unknown model, 429 = rate limited: fall through.
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
  if (rows.length === 0) return null;
  const { data, error } = await sb.from("pantry_items").insert(rows).select("id, raw_text, quantity");
  if (error) throw error;
  return { type: "pantry_review", items: data };
}

async function toolSetProfile(sb: ReturnType<typeof createClient>, patch: Record<string, any>) {
  const householdId = await ensureHousehold(sb);
  await ensureProfile(sb, householdId);
  const allowed = [
    "dietary_restrictions", "allergies", "cuisines_loved", "cuisines_avoided",
    "disliked_ingredients", "household_size", "time_budget_minutes", "skill_level", "notes", "rhythms",
  ];
  const update: Record<string, any> = { updated_at: new Date().toISOString() };
  for (const k of allowed) if (k in patch) update[k] = patch[k];
  const { data, error } = await sb.from("taste_profiles")
    .update(update).eq("household_id", householdId).select("dietary_restrictions, allergies, cuisines_loved, cuisines_avoided, disliked_ingredients, household_size, time_budget_minutes, notes, rhythms").single();
  if (error) throw error;
  return { type: "profile", profile: data };
}

// Week constraints ("monday football, thursday classes") attach to the current week's plan.
function mondayOfCurrentWeek(): string {
  const d = new Date();
  const day = (d.getDay() + 6) % 7; // monday = 0
  d.setDate(d.getDate() - day);
  return d.toISOString().slice(0, 10);
}

async function toolWeekContext(sb: ReturnType<typeof createClient>, constraints: any[]) {
  const householdId = await ensureHousehold(sb);
  const weekOf = mondayOfCurrentWeek();
  const clean = (Array.isArray(constraints) ? constraints : [])
    .filter((c) => c && typeof c.day === "string" && typeof c.note === "string" && c.note.trim())
    .map((c) => ({ day: c.day.toLowerCase(), note: c.note.trim() }))
    .slice(0, 7);
  if (clean.length === 0) return null;

  const { data: existing } = await sb.from("week_plans")
    .select("id, constraints").eq("household_id", householdId).eq("week_of", weekOf).limit(1);

  let planId: string;
  let merged: any[] = clean;
  if (existing && existing.length > 0) {
    planId = existing[0].id as string;
    const prior: any[] = Array.isArray(existing[0].constraints) ? existing[0].constraints : [];
    const byDay = new Map<string, string>();
    for (const c of prior) byDay.set(c.day, c.note);
    for (const c of clean) byDay.set(c.day, c.note); // latest wins per day
    merged = [...byDay.entries()].map(([day, note]) => ({ day, note }));
    await sb.from("week_plans").update({ constraints: merged }).eq("id", planId);
  } else {
    const { data: created, error } = await sb.from("week_plans")
      .insert({ household_id: householdId, week_of: weekOf, constraints: merged }).select("id").single();
    if (error) throw error;
    planId = created.id as string;
  }
  return { type: "week_context", week_of: weekOf, constraints: merged };
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
  };
}

// ---------- intent prompt (v2: parts, benchmarked on tests/fixtures/real-week-prep-001.md) ----------

const SYSTEM = `You parse one message from a person preparing their meals for the week. Extract every useful part. Reply ONLY with JSON, no markdown, no prose:
{"reply": "warm brief reply (1-3 sentences)",
 "parts": [
  {"type": "pantry", "items": [{"raw_text": "ingredient as stated", "quantity": number_or_null, "unit": "unit exactly as stated, or null"}]},
  {"type": "profile", "patch": {"household_size": int_or_absent, "rhythms": [{"kind": "weekly"|"biweekly"|"monthly", "subject": "short label", "detail": "one line"}]}},
  {"type": "week_context", "constraints": [{"day": "monday|tuesday|...|sunday", "note": "short note"}]},
  {"type": "import_recipe", "url": "..."},
  {"type": "plan_week"}
 ]}
Rules:
- Use as many parts as the message contains; real messages usually have several. Omit parts that do not apply.
- pantry: food they HAVE (pantry/fridge/freezer/shopping haul). Never invent units or quantities they did not state.
- profile: standing facts only: household_size, dietary_restrictions[], allergies[], cuisines_loved[], cuisines_avoided[], disliked_ingredients[], rhythms (recurring habits like "pasta once a week", "crockpot every two weeks", "leftovers become weekend lunches").
- week_context: constraints for THIS week only (sports, classes, late nights): day + short note.
- plan_week: when they want the week planned, explicitly or clearly implied.
- reply: acknowledge what you caught; warm, human, brief; never mention being an AI.`;

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

    if (!parsed) {
      return json({ reply: "Hmm, I lost the thread there for a second. Say that again?", cards: [] });
    }

    // Back-compat: v1 shape (single intent) wraps into one part.
    let parts: any[] = Array.isArray(parsed.parts) ? parsed.parts : [];
    if (parts.length === 0 && typeof parsed.intent === "string") {
      const legacy = { type: parsed.intent === "pantry_dump" ? "pantry" : parsed.intent === "set_profile" ? "profile" : parsed.intent };
      if (legacy.type === "pantry") legacy.items = parsed.items;
      if (legacy.type === "profile") legacy.patch = parsed.profile_patch;
      if (legacy.type === "import_recipe") legacy.url = parsed.url;
      parts = [legacy];
    }

    const replyText: string = typeof parsed.reply === "string" && parsed.reply.trim()
      ? parsed.reply.trim()
      : "Right there with you.";
    const cards: any[] = [];
    let planMentioned = false;

    for (const part of parts.slice(0, 6)) {
      try {
        switch (part?.type) {
          case "pantry": {
            const card = await toolPantryDump(sb, Array.isArray(part.items) ? part.items : [{ raw_text: userText }]);
            if (card) cards.push(card);
            break;
          }
          case "profile": {
            const card = await toolSetProfile(sb, part.patch ?? {});
            cards.push(card);
            break;
          }
          case "week_context": {
            const card = await toolWeekContext(sb, part.constraints);
            if (card) cards.push(card);
            break;
          }
          case "import_recipe": {
            const url = typeof part.url === "string" ? part.url : (userText.match(/https?:\/\/\S+/)?.[0] ?? "");
            const result = await toolImportRecipe(sb, url);
            if (result.error) cards.push({ type: "notice", text: result.message });
            else cards.push(result);
            break;
          }
          case "plan_week": {
            planMentioned = true;
            cards.push({ type: "plan_stub" });
            break;
          }
          default:
            break;
        }
      } catch (e: any) {
        console.error("part failed", part?.type, e?.message ?? e);
        cards.push({ type: "notice", text: "One part of that did not land. The rest is saved." });
      }
    }

    let finalReply = replyText;
    if (planMentioned) {
      finalReply += " The one-tap week lands in milestone 3; your week notes are already kept.";
    }

    return json({ reply: finalReply, cards });
  } catch (e: any) {
    console.error("agent-chat error", e?.message ?? e);
    return fail("Something broke in the kitchen. The details are in the function logs.", "server_error", 500);
  }
});
