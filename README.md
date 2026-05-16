# bunpou-web

Experimental frontend for grammar exercises with progress tracking.

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

For future database changes, update `supabase/schema.sql` so the checked-in schema stays in sync with what is applied remotely.

Never expose Supabase service-role or other secret keys in frontend code or browser-delivered environment variables.
