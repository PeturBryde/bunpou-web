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
