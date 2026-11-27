# AnimeStudio — Supabase backend

Project: `wiowdniuhuilukmflvhp` (https://wiowdniuhuilukmflvhp.supabase.co)

- `migrations/` — tables `profiles`, `subscriptions`, `ai_usage` with row-level security
  (users read only their own rows; plan/admin/usage are written only by the server).
- `functions/ai` — AI gateway: verifies the user, checks admin / Pro / monthly quota, calls
  Claude with the `ANTHROPIC_API_KEY` secret (never sent to the app), records usage.
  Optional secrets: `AI_MODEL`, `PRO_TEMPLATES_PER_MONTH` (60), `PRO_CHATS_PER_MONTH` (600).

Make a user the owner (free unlimited AI) — SQL Editor:
`update public.profiles set is_admin = true where email = 'YOUR_EMAIL';`
