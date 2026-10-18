// agent-chat: the chef brain, milestone 2 (v2: multi-part parsing).
// One public endpoint. Flow: chat text -> single-shot LLM parse into parts -> server-side tools.
// The OpenRouter key and the service role key never leave this function.
// Golden fixture: tests/fixtures/real-week-prep-001.md. Any prompt change gets checked against it.

import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-app-token",
};

const DEFAULT_MODEL = Deno.env.get("OPENROUTER_MODEL") ?? "deepseek/deepseek-v4.1-flash-1017";
const FREE_MODELS = [
  "nvidia/nemotron-3-super-120b-a12b:free",
  "nvidia/nemotron-3.5-lightning:free",
  "google/gemma-4-31b-it:free",
  "xingchen-agi/xing4.0-29b-a4b:free",
];
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

async function callLLM(messages: { role: string; content: string }[], maxTokens = 3000): Promise<string> {
  const key = Deno.env.get("OPENROUTER_API_KEY");
  if (!key) throw Object.assign(new Error("missing_key"), { code: "missing_key" });

  const models = [DEFAULT_MODEL, ...FREE_MODELS];
  const deadline = Date.now() + 190000;
  let lastErr: unknown = null;

  for (const model of models) {
    if (Date.now() > deadline) break;
    let res: Response;
    try {
      res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        // Streaming: chunks keep the edge worker alive on long generations.
        body: JSON.stringify({
          model,
          messages,
          max_tokens: maxTokens,
          temperature: 0.3,
          reasoning: { enabled: false },
          stream: true,
        }),
        signal: AbortSignal.timeout(75000),
      });
    } catch {
      lastErr = new Error(`model_${model}_timeout_or_network`);
      continue;
    }
    if (res.ok && res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let out = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            try {
              const j = JSON.parse(payload);
              const piece = j?.choices?.[0]?.delta?.content;
              if (typeof piece === "string") out += piece;
            } catch {
              // ignore keep-alive comment lines
            }
          }
        }
      } catch (e: any) {
        lastErr = new Error(`model_${model}_stream_error: ${String(e?.message ?? e).slice(0, 120)}`);
        if (out.trim()) return out; // partial output beats nothing
        continue;
      }
      if (typeof out === "string" && out.trim()) return out;
      lastErr = new Error(`model_${model}_empty_stream`);
      continue;
    }
    // Any failure (402/404/429/5xx): capture the body, fall through to the next model.
    let body = "";
    try { body = await res.text(); } catch { /* keep empty */ }
    lastErr = new Error(`model_${model}_status_${res.status}: ${body.slice(0, 240)}`);
    continue;
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
  let profile: any;
  if (data && data.length > 0) {
    profile = data[0];
  } else {
    const { data: created, error } = await sb.from("taste_profiles").insert({ household_id: householdId }).select("*").single();
    if (error) throw error;
    profile = created;
  }
  // every kitchen gets three editable slots; Profile 1 carries the current setup
  const { data: existingSlots } = await sb.from("kitchen_profiles").select("id, name").eq("household_id", householdId);
  let slots: any[] = existingSlots ?? [];
  if (slots.filter((s) => String(s.name).startsWith("Profile ")).length < 3) {
    const base = currentProfileValues(profile);
    for (let i = 1; i <= 3; i++) {
      const nm = "Profile " + i;
      if (!slots.some((s) => String(s.name) === nm)) {
        const { data: seeded } = await sb.from("kitchen_profiles")
          .upsert({ household_id: householdId, name: nm, ...(i === 1 ? base : {}) }, { onConflict: "household_id,name" })
          .select("id, name").single();
        if (seeded) slots = [...slots, seeded];
      }
    }
    if (!profile.active_profile_id) {
      const first = slots.find((s) => String(s.name) === "Profile 1");
      if (first) await sb.from("taste_profiles").update({ active_profile_id: first.id }).eq("household_id", householdId);
    }
    await sb.from("kitchen_profiles").delete().eq("household_id", householdId).neq("name", "Profile 1").neq("name", "Profile 2").neq("name", "Profile 3");
  }
  return profile;
}


// ---------- tools ----------

async function toolPantryDump(sb: ReturnType<typeof createClient>, items: any[]) {
  const householdId = await ensureHousehold(sb);
  const { data: unitRows } = await sb.from("units").select("id, name, abbreviation, aliases");
  const aliasMap = new Map<string, string>();
  for (const u of unitRows ?? []) {
    aliasMap.set(u.name.toLowerCase(), u.id);
    if (u.abbreviation) aliasMap.set(u.abbreviation.toLowerCase(), u.id);
    for (const a of Array.isArray(u.aliases) ? u.aliases : []) aliasMap.set(String(a).toLowerCase(), u.id);
  }
  const rows = items
    .filter((i) => i && typeof i.raw_text === "string" && i.raw_text.trim())
    .slice(0, 60)
    .map((i) => {
      let unitId: string | null = null;
      if (typeof i.unit === "string" && i.unit.trim()) {
        const key = i.unit.trim().toLowerCase().replace(/\.+$/, "");
        unitId = aliasMap.get(key) ?? null;
      }
      let qty: number | null = null;
      if (typeof i.quantity === "number" && isFinite(i.quantity)) qty = i.quantity;
      else if (typeof i.quantity === "string" && i.quantity.trim() && !isNaN(Number(i.quantity))) qty = Number(i.quantity);
      return {
        household_id: householdId,
        raw_text: i.raw_text.trim(),
        quantity: qty,
        unit_id: unitId,
        source: "brain-dump",
        confirmed: false,
      };
    });
  if (rows.length === 0) return null;
  const { data, error } = await sb.from("pantry_items").insert(rows).select("id, raw_text, quantity");
  if (error) throw error;
  return { type: "pantry_review", items: data };
}

async function toolSetProfile(sb: ReturnType<typeof createClient>, patch: Record<string, any>) {
  const householdId = await ensureHousehold(sb);
  await ensureProfile(sb, householdId);
  const update: Record<string, any> = { updated_at: new Date().toISOString() };
  // Array fields: only apply when the parser caught real entries; empty arrays never wipe saved facts.
  const arrayFields = ["dietary_restrictions", "allergies", "cuisines_loved", "cuisines_avoided", "disliked_ingredients", "non_negotiables"];
  for (const k of arrayFields) {
    if (k in patch && Array.isArray(patch[k])) {
      const arr = patch[k].map(String).map((s: string) => s.trim()).filter(Boolean);
      if (arr.length) update[k] = arr;
    }
  }
  if ("household_size" in patch && Number(patch.household_size) > 0) update.household_size = Math.round(Number(patch.household_size));
  if ("time_budget_minutes" in patch && Number(patch.time_budget_minutes) > 0) update.time_budget_minutes = Math.round(Number(patch.time_budget_minutes));
  for (const k of ["skill_level", "notes"]) {
    if (k in patch && typeof patch[k] === "string" && patch[k].trim()) update[k] = patch[k].trim().slice(0, 500);
  }
  // Rhythms merge by subject: a new rhythm with the same label replaces it, others survive.
  if (Array.isArray(patch.rhythms) && patch.rhythms.length) {
    const { data: existing } = await sb.from("taste_profiles").select("rhythms").eq("household_id", householdId).limit(1);
    const prior: any[] = Array.isArray(existing?.[0]?.rhythms) ? existing[0].rhythms : [];
    const bySubject = new Map<string, any>();
    for (const r of prior) if (r && r.subject) bySubject.set(String(r.subject).toLowerCase(), r);
    for (const r of patch.rhythms.slice(0, 8)) {
      if (!r || typeof r.subject !== "string" || !r.subject.trim()) continue;
      bySubject.set(r.subject.trim().toLowerCase(), {
        kind: ["weekly", "biweekly", "monthly"].includes(String(r.kind)) ? r.kind : "weekly",
        subject: r.subject.trim().slice(0, 80),
        detail: typeof r.detail === "string" ? r.detail.trim().slice(0, 200) : "",
      });
    }
    update.rhythms = [...bySubject.values()];
  }
  const { data, error } = await sb.from("taste_profiles")
    .update(update).eq("household_id", householdId).select("dietary_restrictions, allergies, cuisines_loved, cuisines_avoided, disliked_ingredients, household_size, time_budget_minutes, notes, rhythms, non_negotiables, active_profile_id").single();
  if (error) throw error;
  // keep the profile you are using in sync: edits land in its slot too
  if (data.active_profile_id) {
    await sb.from("kitchen_profiles").update({ ...currentProfileValues(data), updated_at: new Date().toISOString() }).eq("id", data.active_profile_id);
  }
  return { type: "profile", profile: data };
}
// Week constraints ("monday football, thursday classes") attach to the current week's plan.
function mondayOfCurrentWeek(): string {
  const d = new Date();
  const day = (d.getDay() + 6) % 7; // monday = 0
  d.setDate(d.getDate() - day);
  return d.toISOString().slice(0, 10);
}

function currentProfileValues(p: Record<string, any>): Record<string, any> {
  return {
    household_size: (p.household_size != null && Number(p.household_size) > 0) ? Math.round(Number(p.household_size)) : 2,
    dietary_restrictions: Array.isArray(p.dietary_restrictions) ? p.dietary_restrictions : [],
    allergies: Array.isArray(p.allergies) ? p.allergies : [],
    cuisines_loved: Array.isArray(p.cuisines_loved) ? p.cuisines_loved : [],
    cuisines_avoided: Array.isArray(p.cuisines_avoided) ? p.cuisines_avoided : [],
    disliked_ingredients: Array.isArray(p.disliked_ingredients) ? p.disliked_ingredients : [],
    non_negotiables: Array.isArray(p.non_negotiables) ? p.non_negotiables : [],
    rhythms: Array.isArray(p.rhythms) ? p.rhythms : [],
    time_budget_minutes: p.time_budget_minutes,
    skill_level: p.skill_level,
    notes: p.notes,
  };
}

function slotNameFrom(label: string): string | null {
  const m = String(label ?? "").toLowerCase().match(/profile\s*#?\s*(\d)/);
  if (m) return "Profile " + m[1];
  return null;
}

async function toolSaveIntoSlot(sb: ReturnType<typeof createClient>, label: string) {
  const householdId = await ensureHousehold(sb);
  await ensureProfile(sb, householdId);
  const slotName = slotNameFrom(label);
  if (!slotName) {
    return { error: true, message: "Which slot? Say: keep this setup in profile 2 (slots 1 to 3)." };
  }
  const { data: rows } = await sb.from("taste_profiles").select("*").eq("household_id", householdId).limit(1);
  const p: any = rows?.[0];
  if (!p) return { error: true, message: "No kitchen profile to copy yet." };
  await sb.from("kitchen_profiles")
    .upsert({ household_id: householdId, name: slotName, ...currentProfileValues(p), updated_at: new Date().toISOString() }, { onConflict: "household_id,name" });
  return { slot: slotName };
}

async function toolSwitchProfile(sb: ReturnType<typeof createClient>, name: string) {
  const householdId = await ensureHousehold(sb);
  await ensureProfile(sb, householdId);
  const want = String(name ?? "").trim().toLowerCase().slice(0, 40);
  const { data: sets } = await sb.from("kitchen_profiles").select("*").eq("household_id", householdId);
  const list: any[] = sets ?? [];
  if (list.length === 0) return { error: true, message: "No saved profiles yet. Try: save this profile as dinner party." };
  const target = list.find((s) => String(s.name).toLowerCase() === want)
    ?? list.find((s) => String(s.name).toLowerCase().includes(want) && want.length > 2);
  if (!target) {
    return { error: true, message: `No slot like that. You have: ${list.map((s) => s.name).join(", ")}.` };
  }
  const { data: rows } = await sb.from("taste_profiles").select("*").eq("household_id", householdId).limit(1);
  const p: any = rows?.[0];
  // write the kitchen's current values back into the profile we are leaving, so nothing is lost
  if (p?.active_profile_id) {
    const leaving = list.find((s) => s.id === p.active_profile_id);
    if (leaving && leaving.id !== target.id) {
      await sb.from("kitchen_profiles").update({ ...currentProfileValues(p), updated_at: new Date().toISOString() }).eq("id", leaving.id);
    }
  }
  const { data: afterSwitch, error: switchErr } = await sb.from("taste_profiles").update({
    ...currentProfileValues(target),
    active_profile_id: target.id,
    updated_at: new Date().toISOString(),
  }).eq("household_id", householdId).select("active_profile_id").single();
  if (switchErr) throw switchErr;
  return { type: "profile_switched", name: target.name, profile: target, afterId: afterSwitch?.active_profile_id ?? null };
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
  const blocks = [...html.matchAll(/<script[^>]*type\s*=\s*(["']?)application\/ld\+json\1[^>]*>([\s\S]*?)<\/script>/gi)];
  const candidates: any[] = [];
  for (const b of blocks) {
    try {
        const parsed = JSON.parse(b[2].trim());
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
    author: Array.isArray(r.author) ? (r.author.map((a: any) => (typeof a === "string" ? a : (a?.name ?? ""))).filter(Boolean).join(", ") || (r.publisher?.name ?? null)) : ((typeof r.author === "string" ? r.author : (r.author?.name ?? r.publisher?.name ?? null))),
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
  {"type": "profile", "patch": {"household_size": int_or_absent, "non_negotiables": ["things that MUST happen in the week", "..."], "rhythms": [{"kind": "weekly"|"biweekly"|"monthly", "subject": "short label", "detail": "one line"}]}},
  {"type": "week_context", "constraints": [{"day": "monday|tuesday|...|sunday", "note": "short note"}]},
  {"type": "import_recipe", "url": "..."},
  {"type": "find_recipes", "query": "dish or ingredient keyword", "count": int_1_to_6},
  {"type": "save_profile", "name": "short label"},
  {"type": "switch_profile", "name": "short label"},
  {"type": "plan_week"}
 ]}
Rules:
- Use as many parts as the message contains; real messages usually have several. Omit parts that do not apply.
- pantry: food they HAVE (pantry/fridge/freezer/shopping haul). Never invent units or quantities they did not state.
- profile: standing facts only: household_size, non_negotiables (things that MUST happen this week, like "cake on wednesday", "meatless mondays"), dietary_restrictions[], allergies[], cuisines_loved[], cuisines_avoided[], disliked_ingredients[], rhythms (recurring habits like "pasta once a week", "leftovers become weekend lunches").
- week_context: constraints for THIS week only (sports, classes, late nights): day + short note.
- find_recipes: when they ask you to find/pull/suggest recipes ("pull pasta recipes", "find me something with chicken"). query = short keyword; count = how many (default 3).
- save_profile: when they want to KEEP the current setup in a slot ("keep this setup in profile 2", "save this as profile 3"). name = the slot label like "profile 2".
- switch_profile: when they want to USE another slot ("switch to profile 2", "use profile 3"). name = the slot label like "profile 2". Slots are labeled Profile 1..3, never invented names.
- plan_week: when they want the week planned, explicitly or clearly implied.
- know-how: if the message is a general food/cooking question (technique, doneness, substitution, storage, safety, leftovers, how-to) and NOT a planning action, return parts: [] so the app can answer it directly. reply = a short direct answer (2-4 sentences).
- reply: acknowledge what you caught; warm, human, brief; never mention being an AI.`;

// ---------- food know-how: the cooking questions (Ashley, r/cookingforbeginners) ----------
// Pure food/cooking questions get NO parts (the parser returns []), so they land here.
// The QA brain answers directly, knowing the kitchen's restrictions, allergies and dislikes.
const KITCHEN_QA_SYSTEM = `You answer food and cooking questions inside a home kitchen app. The person just said something with no planning action attached, so answer it directly as their kitchen companion.
Tone: warm, plain-spoken, practical. 2-4 sentences; conversation is the app. No em dashes. Never mention being an AI.
You know their kitchen; honor any dietary restrictions, allergies and disliked ingredients the person's profile shows. If their question touches an ingredient their kitchen avoids, say so plainly.
Food safety ground rules; use the exact numbers when answering doneness or storage: poultry 165F, ground meats 160F, whole pork/beef steaks 145F, danger zone 40-140F for no more than 2 hours, leftovers 3-4 days refrigerated, cooked rice and grains cool quickly and refrigerate promptly. When unsure, throw it out.
If their message is not food or kitchen related at all, keep it to one friendly line that gently steers back to the kitchen.`;

// ---------- milestone 3: the one-tap week ----------
// The planner gets EVERYTHING the kitchen already knows: pantry, profile + rhythms,
// this week's constraints, and the recipe vault. One planning LLM call, then the
// server validates and writes: week entries, gap-list shopping items, prep sessions.

const PLANNER_SYSTEM = `You are the meal-planning brain of a home kitchen app.
You receive: the household taste profile (with standing rhythms), pantry inventory, this week's constraints, and the recipe vault.
Return STRICT JSON only:
{
  "reply": "1-2 warm sentences summarizing the week",
  "days": [
    {"day": "monday", "meals": [
      {"slot": "dinner", "recipe_id": "<uuid from vault or null>", "title": "meal name", "servings": 4, "note": "why this works tonight"}
    ]}
  ],
  "shopping_list": [
    {"raw_text": "exact ingredient with quantity", "quantity": 2, "unit": "lb", "aisle": "produce", "from": "which meal needs it", "have_it": false}
  ],
  "prep_sessions": [
    {"day": "sunday", "focus": "short label", "tasks": [{"text": "imperative task", "minutes": 20, "kind": "active"}]}
  ]
}
RULES:
- days: monday..sunday only, all seven, exactly one dinner per day (plus a lunch or breakfast slot when rhythms imply it).
- recipe_id MUST be a uuid copied from the vault when the meal comes from a saved recipe; use null for simple pantry meals and still give a title.
- Honor week constraints: sports/late-class nights get quick or hands-off meals (crockpot, leftovers, 20-minute dinners).
- Honor rhythms: pasta once a week; crockpot every 2 weeks; leftovers become weekend lunches when the profile says so.
- When the rhythms include leftovers for lunches, add saturday and sunday lunch entries that reuse earlier dinners; mark them in the note.
- Respect dietary restrictions as HARD filters; never plan an allergy. Avoid disliked ingredients and avoided cuisines.
- Use the pantry first; mark shopping_list items the pantry already covers with "have_it": true.
- shopping_list = the GAP only: what must be bought. Merge duplicates. Copy quantities/units from recipes; never invent units.
- prep_sessions: 1-2 sessions max (a real cook day plus maybe a quick midweek session). Tasks ordered, concrete, with rough minutes.
- Servings scale to the household size. Keep it calm and doable, not ambitious.`;

async function fetchWeekContext(sb: ReturnType<typeof createClient>, householdId: string) {
  const weekOf = mondayOfCurrentWeek();
  const [profileRes, pantryRes, planRes, recipesRes] = await Promise.all([
    sb.from("taste_profiles").select("*").eq("household_id", householdId).limit(1),
    sb.from("pantry_items").select("raw_text, quantity, confirmed, unit_id").eq("household_id", householdId).order("added_at", { ascending: false }).limit(40),
    sb.from("week_plans").select("id, constraints").eq("household_id", householdId).eq("week_of", weekOf).limit(1),
    sb.from("recipes").select("id, title, servings, quality_score").eq("household_id", householdId).limit(30),
  ]);
  const profile = profileRes.data?.[0] ?? null;
  const pantry = pantryRes.data ?? [];
  const plan = planRes.data?.[0] ?? null;
  const recipes = recipesRes.data ?? [];
  // Ingredient lines per recipe (for gap math + planner context)
  const ingByRecipe: Record<string, string[]> = {};
  if (recipes.length) {
    const { data: ings } = await sb.from("recipe_ingredients").select("recipe_id, raw_text").in("recipe_id", recipes.map((r: any) => r.id));
    for (const i of ings ?? []) {
      (ingByRecipe[i.recipe_id] ??= []).push(i.raw_text);
    }
  }
  return { weekOf, profile, pantry, plan, recipes, ingByRecipe };
}

function pantryLine(p: any, unitName: string | null): string {
  const qty = p.quantity != null ? `${p.quantity} ` : "";
  return `${qty}${p.raw_text}${unitName ? ` (${unitName})` : ""}`;
}

async function toolPlanWeek(sb: ReturnType<typeof createClient>, userNote: string) {
  const householdId = await ensureHousehold(sb);
  const ctx = await fetchWeekContext(sb, householdId);

  const pantryText = ctx.pantry.map((p: any) => pantryLine(p, null)).join("; ") || "(empty)";
  const recipeLines = ctx.recipes.map((r: any) =>
    `- id ${r.id} | "${r.title}" | serves ${r.servings ?? "?"} | chef score ${r.quality_score ?? "unrated"} | needs: ${(ctx.ingByRecipe[r.id] ?? []).slice(0, 12).join("; ")}`
  ).join("\n") || "(vault is empty: plan simple pantry meals and say the vault needs recipes)";
  const constraintText = (ctx.plan?.constraints ?? []).map((c: any) => `${c.day}: ${c.note}`).join("; ") || "(none)";
  const rhythmText = (ctx.profile?.rhythms ?? []).map((r: any) => `${r.subject} ${r.kind}${r.detail ? ` (${r.detail})` : ""}`).join("; ") || "(none)";
  const profileText = [
    ctx.profile?.household_size ? `household of ${ctx.profile.household_size}` : null,
    (ctx.profile?.dietary_restrictions ?? []).length ? `restrictions: ${ctx.profile.dietary_restrictions.join(", ")}` : null,
    (ctx.profile?.allergies ?? []).length ? `allergies: ${ctx.profile.allergies.join(", ")}` : null,
    (ctx.profile?.cuisines_loved ?? []).length ? `loves: ${ctx.profile.cuisines_loved.join(", ")}` : null,
    (ctx.profile?.cuisines_avoided ?? []).length ? `avoids: ${ctx.profile.cuisines_avoided.join(", ")}` : null,
    (ctx.profile?.disliked_ingredients ?? []).length ? `dislikes: ${ctx.profile.disliked_ingredients.join(", ")}` : null,
    ctx.profile?.time_budget_minutes ? `${ctx.profile.time_budget_minutes} min cook budget` : null,
    ctx.profile?.notes ? `notes: ${ctx.profile.notes}` : null,
  ].filter(Boolean).join(" | ") || "(no profile yet)";

  const userBlock = `TASTE PROFILE: ${profileText}
STANDING RHYTHMS: ${rhythmText}
PANTRY: ${pantryText}
THIS WEEK'S CONSTRAINTS: ${constraintText}
RECIPE VAULT:
${recipeLines}
HOUSEHOLD'S PLANNING NOTE: ${userNote || "(just plan the week)"}`;

  let rawOut: string | null = null;
  try {
    rawOut = await callLLM([
      { role: "system", content: PLANNER_SYSTEM },
      { role: "user", content: userBlock },
    ], 3800);
  } catch (e: any) {
    if (e?.code === "missing_key") throw e;
    return { error: true, message: "The planning model is busy right now. Try again in a minute; your week context is saved." };
  }
  let parsed = parseJsonLoose(rawOut);
  if (!parsed || !Array.isArray(parsed.days)) {
    // one honest retry after a short pause
    await new Promise((r) => setTimeout(r, 4000));
    try {
      rawOut = await callLLM([
        { role: "system", content: PLANNER_SYSTEM },
        { role: "user", content: userBlock + "\n\nReminder: reply ONLY with the JSON object. No prose before or after." },
      ], 3800);
    } catch {
      // fall through to the mangled notice
    }
  }
  parsed = parseJsonLoose(rawOut);
  if (!parsed || !Array.isArray(parsed.days)) {
    return { error: true, message: "The plan came back mangled. Try again in a minute." };
  }

  const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  const recipeById = new Map<string, any>(ctx.recipes.map((r: any) => [r.id, r]));
  const recipeByTitle = new Map<string, any>(ctx.recipes.map((r: any) => [String(r.title).toLowerCase(), r]));

  // Validate days
  const seenDays = new Set<string>();
  const dayRows: { day: string; meals: any[] }[] = [];
  for (const d of parsed.days.slice(0, 7)) {
    if (!d || typeof d.day !== "string") continue;
    const day = DAYS.find((x) => x === d.day.trim().toLowerCase());
    if (!day || seenDays.has(day)) continue;
    seenDays.add(day);
    const meals = (Array.isArray(d.meals) ? d.meals : []).slice(0, 3).map((m: any) => {
      let recipeId: string | null = null;
      if (typeof m?.recipe_id === "string" && recipeById.has(m.recipe_id)) recipeId = m.recipe_id;
      else if (typeof m?.title === "string" && recipeByTitle.has(m.title.trim().toLowerCase())) recipeId = recipeByTitle.get(m.title.trim().toLowerCase()).id;
      let servings = Number(m?.servings);
      if (!Number.isFinite(servings)) servings = ctx.profile?.household_size ?? 2;
      servings = Math.min(12, Math.max(1, servings));
      return {
        slot: typeof m?.slot === "string" ? m.slot.trim().toLowerCase().slice(0, 16) : "dinner",
        recipe_id: recipeId,
        title: typeof m?.title === "string" ? m.title.trim().slice(0, 120) : "Simple dinner",
        servings,
        notes: typeof m?.note === "string" ? m.note.trim().slice(0, 200) : null,
      };
    });
    if (meals.length) dayRows.push({ day, meals });
  }
  if (dayRows.length === 0) {
    return { error: true, message: "The plan came back empty. Try again in a minute." };
  }

  // Validate shopping items: keep the GAP only
  const pantryBlob = ctx.pantry.map((p: any) => String(p.raw_text).toLowerCase()).join(" | ");
  const seenItem = new Set<string>();
  const listItems: any[] = [];
  for (const it of (Array.isArray(parsed.shopping_list) ? parsed.shopping_list : []).slice(0, 40)) {
    if (!it || typeof it.raw_text !== "string" || !it.raw_text.trim()) continue;
    if (it.have_it === true) continue;
    const text = it.raw_text.trim().slice(0, 120);
    const key = text.toLowerCase().replace(/[^a-z0-9 ]/g, "");
    if (seenItem.has(key)) continue;
    // second pantry check: exact word containment of a pantry raw_text
    const covered = ctx.pantry.some((p: any) => {
      const pn = String(p.raw_text).toLowerCase().trim();
      return pn.length > 2 && (key.includes(pn) || pn.includes(key.split(" ")[0] ?? "\u0000"));
    });
    if (covered) continue;
    seenItem.add(key);
    let qty: number | null = null;
    if (typeof it.quantity === "number" && isFinite(it.quantity)) qty = it.quantity;
    else if (typeof it.quantity === "string" && it.quantity.trim() && !isNaN(Number(it.quantity))) qty = Number(it.quantity);
    listItems.push({
      raw_text: text,
      quantity: qty,
      unit_text: typeof it.unit === "string" ? it.unit.trim() : null,
      aisle: typeof it.aisle === "string" ? it.aisle.trim().slice(0, 40) : null,
      from: typeof it.from === "string" ? it.from.trim().slice(0, 80) : null,
    });
  }

  // Validate prep sessions
  const sessions: { day: string; focus: string; tasks: { text: string; minutes: number | null; kind: string }[] }[] = [];
  for (const s of (Array.isArray(parsed.prep_sessions) ? parsed.prep_sessions : []).slice(0, 3)) {
    if (!s || typeof s.day !== "string") continue;
    const day = DAYS.find((x) => x === s.day.trim().toLowerCase());
    if (!day) continue;
    const tasks = (Array.isArray(s.tasks) ? s.tasks : []).slice(0, 14).map((t: any) => ({
      text: typeof t?.text === "string" ? t.text.trim().slice(0, 200) : "",
      minutes: Number.isFinite(Number(t?.minutes)) ? Math.min(180, Math.max(0, Number(t.minutes))) : null,
      kind: t?.kind === "passive" ? "passive" : "active",
    })).filter((t) => t.text);
    if (!tasks.length) continue;
    sessions.push({ day, focus: typeof s.focus === "string" ? s.focus.trim().slice(0, 60) : "cook day", tasks });
  }

  // ---- writes ----
  let planId = ctx.plan?.id as string | undefined;
  if (!planId) {
    const { data: createdPlan, error } = await sb.from("week_plans").insert({ household_id: householdId, week_of: ctx.weekOf, constraints: ctx.plan?.constraints ?? [] }).select("id").single();
    if (error) throw error;
    planId = createdPlan.id;
  }
  // Re-plan replaces the previous draft
  await sb.from("week_plan_entries").delete().eq("week_plan_id", planId);
  await sb.from("shopping_lists").delete().eq("week_plan_id", planId);
  await sb.from("prep_sessions").delete().eq("week_plan_id", planId);

  const entryRows = dayRows.flatMap((d) => d.meals.map((m) => ({
    week_plan_id: planId,
    recipe_id: m.recipe_id,
    day_hint: d.day,
    meal_slot: m.slot,
    servings: m.servings,
    notes: m.notes,
  })));
  if (entryRows.length) {
    const { error } = await sb.from("week_plan_entries").insert(entryRows);
    if (error) throw error;
  }

  // Shopping list (resolve units)
  const { data: unitRows } = await sb.from("units").select("id, name, abbreviation, aliases");
  const aliasMap = new Map<string, string>();
  for (const u of unitRows ?? []) {
    aliasMap.set(u.name.toLowerCase(), u.id);
    if (u.abbreviation) aliasMap.set(u.abbreviation.toLowerCase(), u.id);
    for (const a of Array.isArray(u.aliases) ? u.aliases : []) aliasMap.set(String(a).toLowerCase(), u.id);
  }
  const listRows = listItems.map((it) => ({
    shopping_list_id: null as string | null,
    raw_text: it.raw_text,
    quantity: it.quantity,
    unit_id: it.unit_text ? (aliasMap.get(it.unit_text.toLowerCase().replace(/\.+$/, "")) ?? null) : null,
    aisle: it.aisle,
    provenance: it.from ? [{ from: it.from }] : [],
  }));
  let listCard: any = { type: "shopping_list", items: [], skipped_have: 0 };
  if (listRows.length) {
    const { data: createdList, error } = await sb.from("shopping_lists").insert({ household_id: householdId, week_plan_id: planId }).select("id").single();
    if (error) throw error;
    const { data: savedItems, error: liErr } = await sb.from("shopping_list_items").insert(listRows.map((r) => ({ ...r, shopping_list_id: createdList.id }))).select("id, raw_text, quantity");
    if (liErr) throw liErr;
    listCard = { type: "shopping_list", items: savedItems, skipped_have: (Array.isArray(parsed.shopping_list) ? parsed.shopping_list : []).filter((x: any) => x?.have_it === true).length };
  }

  // Prep sessions + tasks
  const sessionCards: any[] = [];
  for (const s of sessions) {
    const dayIndex = DAYS.indexOf(s.day);
    const date = new Date(ctx.weekOf + "T12:00:00Z");
    date.setUTCDate(date.getUTCDate() + dayIndex);
    const { data: sess, error } = await sb.from("prep_sessions").insert({ household_id: householdId, week_plan_id: planId, scheduled_for: date.toISOString().slice(0, 10) }).select("id").single();
    if (error) throw error;
    const { data: savedTasks, error: tErr } = await sb.from("prep_tasks").insert(s.tasks.map((t, idx) => ({
      prep_session_id: sess.id,
      text: t.text,
      kind: t.kind,
      minutes: t.minutes,
      order_index: idx,
    }))).select("id, text, minutes, kind, order_index");
    if (tErr) throw tErr;
    sessionCards.push({ type: "cook_guide", day: s.day, focus: s.focus, tasks: savedTasks });
  }

  // Card: week plan (from what we wrote)
  const recipeTitles = new Map(ctx.recipes.map((r: any) => [r.id, r.title]));
  const weekCard = {
    type: "week_plan",
    week_of: ctx.weekOf,
    days: dayRows.map((d) => ({
      day: d.day,
      meals: d.meals.map((m) => ({
        slot: m.slot,
        title: m.recipe_id ? recipeTitles.get(m.recipe_id) ?? m.title : m.title,
        servings: m.servings,
        note: m.notes,
        from_vault: Boolean(m.recipe_id),
      })),
    })),
  };

  let reply = typeof parsed.reply === "string" && parsed.reply.trim() ? parsed.reply.trim() : "Here is your week.";
  if (dayRows.length >= 5 && /don.t have|do not have|tell me what/i.test(reply)) {
    reply = "Here's your week, built from your pantry, your rhythms, and this week's schedule.";
  }
  return { error: false, cards: [weekCard, listCard, ...sessionCards], reply };
}
// ---------- discovery: find recipes from the web, chef-gated ----------
// Free source: TheMealDB public API (no key). Attribution + linkback always.
// Hard filters: allergies and disliked ingredients reject BEFORE scoring.

const DISCOVERY_SYSTEM = `You are a chef curating recipe candidates for a household. You receive the household profile and candidate recipes (title, ingredients, steps). Return STRICT JSON only:
{"scores": [{"index": 0, "score": 0-100, "verdict": "accept"|"reject", "notes": ["one short note"], "fit": "one short line on why it fits this household"}]}
Rules:
- score = your honest chef judgment: method soundness, sane quantities, clarity, ingredient realism (0-100).
- verdict = "reject" if method is incoherent, quantities are absurd, or it cannot be a real dinner.
- notes: max 3, short, specific. fit: mention how it matches (or misses) the profile's cuisines and rhythms.`;

function mealDbLine(ing: unknown, meas: unknown): string | null {
  const i = String(ing ?? "").trim();
  const m = String(meas ?? "").trim();
  if (!i || i.toLowerCase() === "null") return null;
  return `${m ? m + " " : ""}${i}`.trim();
}

function allergiesHit(haystack: string, needles: string[]): string | null {
  const h = haystack.toLowerCase();
  for (const n of needles) {
    const term = String(n).toLowerCase().trim();
    if (term.length > 2 && h.includes(term)) return n;
  }
  return null;
}

async function toolFindRecipes(sb: ReturnType<typeof createClient>, query: string, count: number) {
  const householdId = await ensureHousehold(sb);
  const { data: profileRow } = await sb.from("taste_profiles").select("*").eq("household_id", householdId).limit(1);
  const profile = profileRow?.[0] ?? null;
  const allergies = (profile?.allergies ?? []).map(String);
  const disliked = (profile?.disliked_ingredients ?? []).map(String);
  const restrictions = (profile?.dietary_restrictions ?? []).map(String).map((s: string) => s.toLowerCase());

  const q = query.trim().slice(0, 60);
  const want = Math.min(6, Math.max(1, Number(count) || 3));
  const searchUrl = `https://www.themealdb.com/api/json/v1/1/search.php?s=${encodeURIComponent(q)}`;
  let meals: any[] = [];
  try {
    const res = await fetch(searchUrl, { signal: AbortSignal.timeout(20000) });
    if (res.ok) {
      const data = await res.json();
      meals = Array.isArray(data?.meals) ? data.meals : [];
    }
  } catch {
    // fall through to ingredient filter
  }
  if (meals.length < 3) {
    // thin results: merge in by-ingredient matches (dedupe by idMeal)
    const ing = q.split(/[ ,]+/)[0] ?? "";
    if (ing) {
      try {
        const res2 = await fetch(`https://www.themealdb.com/api/json/v1/1/filter.php?i=${encodeURIComponent(ing)}`, { signal: AbortSignal.timeout(20000) });
        if (res2.ok) {
          const data2 = await res2.json();
          const have = new Set(meals.map((m: any) => m.idMeal));
          const ids: string[] = (data2?.meals ?? []).map((m: any) => m.idMeal).filter((id: string) => !have.has(id));
          for (const id of ids.slice(0, 8 - meals.length)) {
            try {
              const detailRes = await fetch(`https://www.themealdb.com/api/json/v1/1/lookup.php?i=${id}`, { signal: AbortSignal.timeout(20000) });
              if (!detailRes.ok) continue;
              const d2 = await detailRes.json();
              if (Array.isArray(d2?.meals) && d2.meals[0]) meals.push(d2.meals[0]);
            } catch {
              // skip this one
            }
          }
        }
      } catch {
        // stay with what we have
      }
    }
  }
  if (meals.length === 0) {
    return { error: false, cards: [{ type: "notice", text: `Nothing surfaced for "${q}". Try another word: an ingredient or a dish.` }], reply: `Nothing surfaced for "${q}" yet.` };
  }

  // Shape candidates; hard-filter allergies/dislikes BEFORE spending a scoring call.
  const { data: existingRows } = await sb.from("recipes").select("title, source_url").eq("household_id", householdId);
  const existingTitles = new Set((existingRows ?? []).map((r: any) => String(r.title).toLowerCase()));
  const candidates: any[] = [];
  for (const m of meals) {
    if (candidates.length >= Math.min(6, want + 2)) break;
    const ingredientLines: string[] = [];
    for (let i = 1; i <= 20; i++) {
      const line = mealDbLine(m[`strIngredient${i}`], m[`strMeasure${i}`]);
      if (line) ingredientLines.push(line);
    }
    const steps = String(m.strInstructions ?? "").split(/\r?\n+/).map((s: string) => s.trim()).filter(Boolean);
    const title = String(m.strMeal ?? "").trim();
    if (!title || existingTitles.has(title.toLowerCase())) continue;
    const blob = (ingredientLines.join(" ") + " " + title).toLowerCase();
    const hit = allergiesHit(blob, [...allergies, ...disliked]);
    if (hit) continue;
    if (restrictions.some((r: string) => (r === "vegetarian" || r === "vegan") && /chicken|beef|pork|bacon|sausage|steak|turkey|lamb|shrimp|fish|salmon|tuna/.test(blob))) continue;
    if (restrictions.some((r: string) => r === "halal" && /pork|bacon|wine|beer|rum|whiskey/.test(blob))) continue;
    if (restrictions.some((r: string) => r === "kosher" && /pork|bacon|shellfish|shrimp|crab|lobster/.test(blob))) continue;
    candidates.push({
      idMeal: m.idMeal,
      title,
      category: m.strCategory ?? null,
      cuisine: m.strArea ?? null,
      image: m.strMealThumb ?? null,
      sourceUrl: (typeof m.strSource === "string" && m.strSource.trim()) ? m.strSource.trim() : `https://www.themealdb.com/meal/${m.idMeal}`,
      servings: profile?.household_size ?? 4,
      ingredientLines,
      steps,
    });
  }
  if (candidates.length === 0) {
    return { error: false, cards: [{ type: "notice", text: `Found ${meals.length} for "${q}" but none fit your kitchen's rules (allergies and dislikes are hard lines). Want a different direction?` }], reply: `Nothing fit your kitchen's rules for "${q}"; your lines held. Want me to try another direction?` };
  }

  // One batched scoring call
  const profileText = [
    profile?.household_size ? `household of ${profile.household_size}` : null,
    (profile?.cuisines_loved ?? []).length ? `loves: ${profile.cuisines_loved.join(", ")}` : null,
    (profile?.cuisines_avoided ?? []).length ? `avoids: ${profile.cuisines_avoided.join(", ")}` : null,
    (profile?.rhythms ?? []).length ? `rhythms: ${profile.rhythms.map((r: any) => r.subject).join(", ")}` : null,
  ].filter(Boolean).join(" | ") || "(none yet)";
  const candBlock = candidates.map((c, i) => `[${i}] "${c.title}" (${c.cuisine ?? "?"} ${c.category ?? ""})
ingredients: ${c.ingredientLines.slice(0, 12).join("; ")}
steps: ${c.steps.slice(0, 4).map((s: string) => s.slice(0, 100)).join(" | ")}`).join("\n\n");
  let scores: any[] = [];
  try {
    const out = await callLLM([
      { role: "system", content: DISCOVERY_SYSTEM },
      { role: "user", content: `HOUSEHOLD: ${profileText}\n\nCANDIDATES:\n${candBlock}` },
    ], 1800);
    const parsed = parseJsonLoose(out);
    if (parsed && Array.isArray(parsed.scores)) scores = parsed.scores;
  } catch {
    // scoring unavailable: save un-scored, honestly
  }

  const byIndex = new Map<number, any>();
  for (const s of scores) {
    const i = Number(s?.index);
    if (Number.isInteger(i)) byIndex.set(i, s);
  }

  const keepers = candidates
    .map((c, i) => ({ c, s: byIndex.get(i) }))
    .filter(({ s }) => !s || (s.verdict !== "reject" && Number(s.score) >= 55))
    .sort((a, b) => (Number(b.s?.score) || 0) - (Number(a.s?.score) || 0))
    .slice(0, want);

  if (keepers.length === 0) {
    return { error: false, cards: [{ type: "notice", text: `The chef looked at the "${q}" options and none passed the rubric. Want a different direction?` }], reply: `None of the "${q}" options passed the chef rubric. Want a different direction?` };
  }

  // Save keepers + build cards
  const cards: any[] = [];
  for (const { c, s } of keepers) {
    const attribution = `TheMealDB · ${c.title}`;
    const { data: saved, error } = await sb.from("recipes").insert({
      household_id: householdId,
      title: c.title,
      servings: c.servings,
      cuisine: c.cuisine ?? "",
      image_url: c.image,
      source_url: c.sourceUrl,
      attribution,
      quality_score: s ? Math.max(0, Math.min(100, Math.round(Number(s.score)))) : null,
      quality_notes: s && Array.isArray(s.notes) ? s.notes.map(String).slice(0, 5) : [],
      status: "imported",
    }).select("id").single();
    if (error) continue;
    if (c.ingredientLines.length) {
      await sb.from("recipe_ingredients").insert(c.ingredientLines.map((t: string, idx: number) => ({
        recipe_id: saved.id,
        raw_text: t,
        position: idx,
      })));
    }
    if (c.steps.length) {
      await sb.from("recipe_steps").insert(c.steps.map((t: string, idx: number) => ({
        recipe_id: saved.id,
        position: idx,
        text: t,
        kind: "active",
      })));
    }
    cards.push({
      type: "recipe",
      recipe: {
        title: c.title,
        quality_score: s ? Math.round(Number(s.score)) : null,
        quality_notes: s && Array.isArray(s.notes) ? s.notes.map(String).slice(0, 3) : [],
        ingredients_count: c.ingredientLines.length,
        steps_count: c.steps.length,
        servings: c.servings,
        source_url: c.sourceUrl,
        attribution,
        fit: s?.fit ?? null,
      },
    });
  }
  if (cards.length === 0) {
    return { error: false, cards: [{ type: "notice", text: `The "${q}" picks saved with a hiccup. Try again?` }], reply: "The picks hiccuped on save. Try again?" };
  }
  const reply = `Pulled ${cards.length} for "${q}", chef-scored against your kitchen. Tap a card for the source.`;
  return { error: false, cards, reply };
}
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method === "GET") {
    const token = req.headers.get("x-app-token") ?? "";
    if (ACCESS_TOKEN && token !== ACCESS_TOKEN) return fail("Unauthorized", "unauthorized", 401);
    const sbg = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { persistSession: false } },
    );
    const householdId = await ensureHousehold(sbg);
    const { data: profile } = await sbg.from("taste_profiles").select("*").eq("household_id", householdId).limit(1);
    const { count: pantryCount } = await sbg.from("pantry_items").select("*", { count: "exact", head: true }).eq("household_id", householdId);
    const { count: recipeCount } = await sbg.from("recipes").select("*", { count: "exact", head: true }).eq("household_id", householdId);
    const { data: profileSets } = await sbg.from("kitchen_profiles").select("id, name, household_size, dietary_restrictions, allergies, cuisines_loved, cuisines_avoided, disliked_ingredients, non_negotiables, rhythms, updated_at").eq("household_id", householdId).order("created_at");
    const activeId = (profile && profile[0]) ? profile[0].active_profile_id : null;
    const sets = (profileSets ?? []).map((s: any) => ({ id: s.id, name: s.name, is_current: s.id === activeId }));
    return new Response(JSON.stringify({
      profile: profile?.[0] ?? null,
      pantry_count: pantryCount ?? 0,
      recipe_count: recipeCount ?? 0,
      profiles: sets,
    }), { headers: { ...CORS, "Content-Type": "application/json" } });
  }
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
    // Deterministic UI commands: taps and form saves from the app carry an exact command,
    // so they never depend on the LLM parser. Freeform chat still parses as usual.
    const cmd: any = body?.command ?? null;
    if (cmd && typeof cmd.type === "string") {
      const cmdCards: any[] = [];
      let cmdReply = "";
      try {
        switch (cmd.type) {
          case "switch_profile": {
            const switched = await toolSwitchProfile(sb, String(cmd.name ?? ""));
            if (switched.error) {
              cmdCards.push({ type: "notice", text: switched.message ?? "Switch hiccuped." });
            } else {
              cmdReply = `Switched to ${switched.name}. The profile you left kept everything it had.`;
            }
            break;
          }
          case "set_profile": {
            const card = await toolSetProfile(sb, (cmd.patch && typeof cmd.patch === "object") ? cmd.patch : {});
            cmdCards.push(card);
            cmdReply = ((card as any)?.profile?.active_profile_id) ? "Saved. The profile in use picked up every change." : "Saved your kitchen.";
          }
            break;
          default:
            cmdReply = "";
            cmdCards.push({ type: "notice", text: "Unknown command." });
        }
      } catch (cmdErr: any) {
        console.error("command failed", cmd.type, cmdErr?.message ?? cmdErr);
        return json({ reply: "That tap did not land. Give it another go; the kitchen is safe.", cards: [{ type: "notice", text: String(cmdErr?.message ?? cmdErr).slice(0, 140) }] });
      }
      return json({ reply: cmdReply || "The kitchen heard you.", cards: cmdCards });
    }

    let parsed: any = null;
    try {
      let out: string | null = null;
      try {
        out = await callLLM([
          { role: "system", content: SYSTEM },
          { role: "user", content: userText },
        ]);
      } catch (llmErr: any) {
        if (llmErr?.code === "missing_key") throw llmErr;
        await new Promise((r) => setTimeout(r, 4000));
        out = await callLLM([
          { role: "system", content: SYSTEM },
          { role: "user", content: userText },
        ]);
      }
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
    let finalReply = replyText;

    // No planning action in the message? Then it is either a food/cooking question or
    // just a hello; the QA brain answers it as the kitchen companion. If the QA call
    // fails, fall back to the parser's short reply so the chat never goes quiet.
    if (parts.length === 0) {
      try {
        const kitchenBits: string[] = [];
        if (profile && profile[0]) {
          const p: any = profile[0];
          if (p.household_size) kitchenBits.push("household of " + p.household_size);
          if (Array.isArray(p.dietary_restrictions) && p.dietary_restrictions.length) kitchenBits.push("dietary restrictions: " + p.dietary_restrictions.join(", "));
          if (Array.isArray(p.allergies) && p.allergies.length) kitchenBits.push("allergies: " + p.allergies.join(", "));
          if (Array.isArray(p.disliked_ingredients) && p.disliked_ingredients.length) kitchenBits.push("nobody likes: " + p.disliked_ingredients.join(", "));
          if (Array.isArray(p.non_negotiables) && p.non_negotiables.length) kitchenBits.push("non-negotiables: " + p.non_negotiables.join(", "));
        }
        const ctx = kitchenBits.length ? "Their kitchen: " + kitchenBits.join("; ") + "." : "Their kitchen profile is still empty.";
        const qaOut = await callLLM([
          { role: "system", content: KITCHEN_QA_SYSTEM + "\n" + ctx },
          { role: "user", content: userText },
        ]);
        const qaReply = typeof qaOut === "string" && qaOut.trim() ? qaOut.trim() : "";
        if (qaReply) finalReply = qaReply;
      } catch (qaErr: any) {
        if (qaErr?.code === "missing_key") throw qaErr;
        console.error("QA brain failed, using parser reply", qaErr?.message ?? qaErr);
      }
    }

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
          case "save_profile": {
            const copied = await toolSaveIntoSlot(sb, typeof part.name === "string" ? part.name : "");
            if (copied.error) cards.push({ type: "notice", text: copied.message ?? "Save hiccuped." });
            else finalReply = `Copied this setup into ${copied.slot}. Nothing changed in what you are using now.`;
            break;
          }
          case "switch_profile": {
            const switched = await toolSwitchProfile(sb, typeof part.name === "string" ? part.name : "");
            if (switched.error) cards.push({ type: "notice", text: switched.message ?? "Switch hiccuped." });
            else finalReply = `Switched to ${switched.name}. The profile you left kept everything it had.`;
            break;
          }
          case "find_recipes": {
            const found = await toolFindRecipes(sb, typeof part.query === "string" ? part.query : userText, Number(part.count) || 3);
            if (found.error) cards.push({ type: "notice", text: found.message ?? "Search hiccuped." });
            else { cards.push(...found.cards); finalReply = found.reply; }
            break;
          }
          case "plan_week": {
            const planResult = await toolPlanWeek(sb, typeof part.notes === "string" ? part.notes : userText);
            if (planResult.error) cards.push({ type: "notice", text: planResult.message });
            else { cards.push(...planResult.cards); finalReply = planResult.reply; }
            break;
          }
          default:
            break;
        }
      } catch (e: any) {
        console.error("part failed", part?.type, e?.message ?? e);
        cards.push({ type: "notice", text: "The " + (part?.type ?? "unknown") + " part did not land (" + String(e?.message ?? e).slice(0, 140) + "). The rest is saved." });
      }
    }


    return json({ reply: finalReply, cards });
  } catch (e: any) {
    console.error("agent-chat error", e?.message ?? e);
    const msg = e?.code === "llm_unavailable"
      ? "The chef brain is rate-limited right now. Give it a minute and send that again."
      : "Something broke in the kitchen. Try again in a minute; if it keeps happening, Juno is on it.";
    return json({ error: "server_error", message: msg, detail: String(e?.message ?? e).slice(0, 200) }, 503);
  }
});
