# bunpou-web

Experimental frontend for grammar exercises with progress tracking.

In-progress drill answers are persisted to Supabase `public.drill_progress` for signed-in users, with `localStorage` kept as a fallback/cache during development.

Completed attempts are now saved to Supabase `public.drill_attempts`. Retakes are intentionally blocked by the database unique constraint on `(user_id, drill_uid)`, and the existing completed attempt is shown as read-only. Completed attempts can also be exported to ChatGPT for external tracking, and import confirmation is tracked per attempt via `import_confirmed_at`.

## Local development

1. Install dependencies:
   ```bash
   npm install
   ```
2. Create a local env file from the example:
   ```bash
   cp .env.example .env.local
   ```
3. Fill in `.env.local` with your Supabase values:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_PUBLISHABLE_KEY`
4. Start the local dev server:
   ```bash
   npm run dev
   ```

## Build

```bash
npm run build
```

## Supabase schema notes

This app uses Supabase Auth with Postgres tables for drill progress and attempts. The initial schema was applied manually in the Supabase SQL editor, and the rerunnable reference SQL now lives in `supabase/schema.sql`.



Re-run the SQL in `supabase/schema.sql` in the Supabase SQL editor whenever schema changes are introduced so export-tracking fields (including `last_export_batch_id` and `last_exported_at`) are added to `public.drill_attempts`.
For future database changes, update `supabase/schema.sql` so the checked-in schema stays in sync with what is applied remotely.

Never expose Supabase service-role or other secret keys in frontend code or browser-delivered environment variables.
