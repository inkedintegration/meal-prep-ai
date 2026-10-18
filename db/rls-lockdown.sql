-- v1 preview: all access flows through the agent-chat edge function (service role).
-- Lock the public anon key out of every table until real user accounts exist.
alter table households enable row level security;
alter table taste_profiles enable row level security;
alter table ingredients enable row level security;
alter table units enable row level security;
alter table substitutions enable row level security;
alter table recipes enable row level security;
alter table recipe_ingredients enable row level security;
alter table recipe_steps enable row level security;
alter table pantry_items enable row level security;
alter table week_plans enable row level security;
alter table week_plan_entries enable row level security;
alter table shopping_lists enable row level security;
alter table shopping_list_items enable row level security;
alter table prep_sessions enable row level security;
alter table prep_tasks enable row level security;
