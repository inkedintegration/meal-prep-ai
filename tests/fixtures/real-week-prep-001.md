# Golden test case 001: real week-prep message

Source: Ashley Romero's own message, Oct 2026. "An example of a real human preparing for their week of meals." The parser must handle this shape; any agent change gets checked against it.

## Input

I have 2 pounds of chicken. pasta and tortillas in my pantry. I have a busy week ahead, Monday and Tuesday are football. Thursday night classes and feeding a family of four. We have pasta at least once a week. Make crockpot meals every 2 weeks and leftovers for lunch on the weekend.

## Expected decomposition (compound, not single-intent)

- pantry: chicken (qty 2, unit lb), pasta (no qty), tortillas (no qty)
- profile: household_size 4
- profile rhythms (recurring standing habits): pasta at least weekly; crockpot meals every 2 weeks; leftovers become weekend lunches
- week_context: monday football, tuesday football, thursday evening classes
- plan_week: implied by "busy week ahead" + "feeding a family"

## What it taught the design

1. One message, many intents: the parser returns parts[], executed in order.
2. Standing habits need a home: taste_profiles.rhythms (weekly/biweekly patterns), not one-off notes.
3. Week-specific constraints live on the week plan (constraints jsonb), not the profile: football Tuesdays are not forever.
4. Planning intent is often implied ("busy week ahead"), not commanded.

## Parser behavior (validated Oct 2026, free-tier model)

Correctly returned all 4 parts. One quirk fixed in the prompt: never invent units the user did not state.
