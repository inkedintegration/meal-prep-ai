-- v1 data spine. Postgres (Supabase-compatible). uuid pk, timestamptz, soft where useful.
-- Naming: singular-ish, plain. No AGPL code here: clean-room design from spec docs.

create extension if not exists "pgcrypto";

-- Households: single-user in v1, room to share later
create table if not exists households (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'My kitchen',
  created_at timestamptz not null default now()
);

-- Taste profile: the anti-overwhelm engine brain
create table if not exists taste_profiles (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  -- hard filters (allergies, diets): nothing violating these gets proposed
  dietary_restrictions jsonb not null default '[]',   -- ["dairy-free","vegetarian"]
  allergies jsonb not null default '[]',              -- ["peanuts"]
  -- soft weights
  cuisines_loved jsonb not null default '[]',
  cuisines_avoided jsonb not null default '[]',
  disliked_ingredients jsonb not null default '[]',   -- ["cilantro"]
  household_size int not null default 2,
  time_budget_minutes int,        -- per cook session
  skill_level text default 'home-cook',
  notes text,                     -- free-form context the AI may use
  updated_at timestamptz not null default now()
);

-- Canonical foods: LLM-normalized at entry, one row per real-world ingredient
create table if not exists ingredients (
  id uuid primary key default gen_random_uuid(),
  canonical_name text not null,
  aliases jsonb not null default '[]',   -- ["chicken breasts","chicken breast"]
  category text,                         -- produce/protein/dairy/pantry...
  created_at timestamptz not null default now()
);

create table if not exists units (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  plural_name text,
  abbreviation text,
  gram_weight numeric,   -- for mass-based consolidation when a scale is involved
  aliases jsonb not null default '[]'
);

-- Substitution pairs: validated by food logic, then by the chef rubric
create table if not exists substitutions (
  id uuid primary key default gen_random_uuid(),
  from_ingredient_id uuid references ingredients(id),
  to_ingredient_id uuid references ingredients(id),
  ratio numeric default 1.0,
  note text,
  context jsonb default '{}'   -- e.g. works-in-baking vs works-in-savory
);

-- Recipes: web-sourced with provenance, or founder/draft
create table if not exists recipes (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  title text not null,
  source_url text,                 -- provenance: where it came from
  source_name text,                -- attribution display name
  attribution text,                -- author/site credit shown to the user
  status text not null default 'imported',  -- imported | tested | draft
  quality_score numeric,           -- chef-rubric gate 0..100
  quality_notes jsonb default '[]',
  servings numeric default 4,
  component_flags jsonb not null default '[]',  -- ["protein","starch","veg","sauce","dish"]
  shelf_life text,                 -- eat-fresh | keeps-3-4d | freezer-friendly
  prep_minutes int,
  cook_minutes int,
  equipment jsonb not null default '[]',        -- ["oven","burner","blender"]
  cuisine text,
  image_url text,
  imported_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists recipe_ingredients (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references recipes(id) on delete cascade,
  ingredient_id uuid references ingredients(id),  -- null while unparsed
  raw_text text not null,            -- original line, always kept
  quantity numeric,
  unit_id uuid references units(id),
  prep_note text,                    -- "finely diced"
  optional boolean default false,
  position int not null default 0
);

create table if not exists recipe_steps (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references recipes(id) on delete cascade,
  position int not null,
  text text not null,
  kind text not null default 'active',   -- active | passive
  equipment text,
  minutes int,
  depends_on jsonb default '[]'          -- step ids/positions this waits for
);

-- Pantry: quantities + freshness, not a boolean
create table if not exists pantry_items (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  ingredient_id uuid references ingredients(id),
  raw_text text not null default '',     -- pre-normalization capture
  quantity numeric,
  unit_id uuid references units(id),
  added_at date not null default current_date,
  use_by date,                            -- rough freshness
  source text default 'brain-dump',       -- brain-dump | receipt | manual
  confirmed boolean default false,        -- review-card approval
  created_at timestamptz not null default now()
);

-- Week plans: meal pool, not calendar-locked
create table if not exists week_plans (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  week_of date not null,
  created_at timestamptz not null default now()
);

create table if not exists week_plan_entries (
  id uuid primary key default gen_random_uuid(),
  week_plan_id uuid not null references week_plans(id) on delete cascade,
  recipe_id uuid references recipes(id),
  day_hint text,          -- optional: monday..sunday or null for pool
  meal_slot text default 'dinner',
  servings numeric not null default 1,
  notes text
);

-- Shopping lists: merged quantities + provenance
create table if not exists shopping_lists (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  week_plan_id uuid references week_plans(id),
  created_at timestamptz not null default now()
);

create table if not exists shopping_list_items (
  id uuid primary key default gen_random_uuid(),
  shopping_list_id uuid not null references shopping_lists(id) on delete cascade,
  ingredient_id uuid references ingredients(id),
  raw_text text not null default '',
  quantity numeric,
  unit_id uuid references units(id),
  aisle text,                       -- grouping for the store run
  checked boolean default false,
  provenance jsonb not null default '[]'  -- [{recipe_id, scale}] contributors
);

-- Prep sessions: ordered task run with timers
create table if not exists prep_sessions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  week_plan_id uuid references week_plans(id),
  scheduled_for date,
  created_at timestamptz not null default now()
);

create table if not exists prep_tasks (
  id uuid primary key default gen_random_uuid(),
  prep_session_id uuid not null references prep_sessions(id) on delete cascade,
  recipe_id uuid references recipes(id),
  step_ref int,                     -- recipe_steps.position when task maps to a step
  text text not null,
  kind text not null default 'active',
  equipment text,
  minutes int,
  order_index int not null default 0,
  done boolean default false
);

-- Helpful indexes
create index if not exists idx_recipes_household on recipes(household_id);
create index if not exists idx_pantry_household on pantry_items(household_id);
create index if not exists idx_pantry_use_by on pantry_items(use_by) where use_by is not null;
create index if not exists idx_ingredients_name on ingredients(canonical_name);
create index if not exists idx_recipe_steps_recipe on recipe_steps(recipe_id, position);

-- Standing habits ("pasta weekly", "crockpot every 2 weeks") + per-week constraints
alter table taste_profiles add column if not exists rhythms jsonb not null default '[]';
alter table week_plans add column if not exists constraints jsonb not null default '[]';
