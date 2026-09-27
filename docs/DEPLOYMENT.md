# Git Galaxy deployment

## Production shape

- Vercel runs `app.py` as one FastAPI function.
- The Vite client is built from `web/` and mounted by FastAPI at `/`.
- Local development reads `data/universe.db`.
- Production reads Supabase Postgres whenever `POSTGRES_URL` is present.
- GitHub credentials and database credentials are environment variables only.

## First deployment

1. Import `andy6609/git-galaxy` as a Vercel project.
2. Connect the Supabase Marketplace resource to that Vercel project.
3. Confirm that Vercel has synchronized `POSTGRES_URL` and the Supabase variables.
4. Apply `supabase/migrations/001_universe.sql` in the Supabase SQL Editor.
5. Pull the production variables locally with `vercel env pull .env.local`.
6. Import the checked-in universe:

   ```bash
   set -a
   source .env.local
   set +a
   .venv/bin/python scripts/import_sqlite_to_postgres.py
   ```

7. Deploy again and verify `/api/world`, `/api/resolve?q=andy6609`, and a new-account ingestion.

The import is idempotent. Existing primary keys are not overwritten. Keep
`data/universe.db` as the reproducible prototype snapshot until the Supabase
copy has been verified and backed up.

## Required variables

| Variable | Purpose |
|---|---|
| `POSTGRES_URL` | Supabase pooled Postgres connection used by FastAPI |
| `GITHUB_TOKEN` | Optional server-only token for a higher lazy-ingestion API budget |

Do not expose either variable with a `VITE_` prefix and do not commit `.env*`.
