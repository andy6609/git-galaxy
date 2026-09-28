<div align="center">

# Git Galaxy

**Discover where your GitHub work lives in the open-source universe.**

Every GitHub account becomes a star system. Every public repository becomes a planet.
Related builders gather into regions and galaxies shaped by real project data.

[Explore the live universe](https://git-galaxy-bice.vercel.app) · [Read the product direction](docs/DIRECTION.md) · [See the prototype spec](docs/PROTOTYPE_SPEC.md)

</div>

![Git Galaxy universe view](docs/experiments/E1d/universe.jpg)

> [!NOTE]
> Git Galaxy is an early prototype. The current universe is a growing sample, not a complete map of GitHub. Search for a public GitHub account to place it in the shared universe.

## What is Git Galaxy?

Git Galaxy turns public repository data into a navigable 3D world:

- **Account → star system.** A GitHub user or organization owns one stable system.
- **Repository → planet.** Public, non-fork repositories orbit their account's star.
- **Creation order → orbit.** Older repositories stay closer to the center; newer ones appear farther out.
- **Project data → appearance.** Repository identity, language, age, and activity influence the planet without turning popularity into beauty.
- **Similarity → geography.** Accounts working on related things form regions and galaxies.
- **Verified dependencies → routes.** A route represents a known relationship, not a decorative connection.

The goal is not to rank developers. It is to make open source feel like a place: somewhere you can find your own work, understand its neighborhood, and choose where to travel next.

## Try it

Open **[git-galaxy-bice.vercel.app](https://git-galaxy-bice.vercel.app)** and search for:

- a GitHub username, such as `andy6609`
- a repository, such as `facebook/react`
- a full GitHub repository URL
- a known package name

No GitHub login is required. Git Galaxy reads public metadata only.

Direct links are supported:

```text
?u=USERNAME       open an account's star system
?r=OWNER/REPO     open a repository planet
?p=REPOSITORY_ID  open a planet by its stable GitHub ID
```

## Why it feels different

Git Galaxy deliberately avoids a few common visualization shortcuts:

- Stars do not make a planet larger or more beautiful. Popularity only affects long-distance visibility.
- Small and zero-star repositories receive the same arrival treatment as famous projects.
- Coordinates are persistent. Once a system is placed, changing metadata does not move its address.
- Unknown data is not presented as zero.
- Decorative stars and dust are never counted as repositories.
- The same planet remains the same object as the camera moves from galaxy scale to orbit.

These rules keep the world expressive without pretending that GitHub metrics measure quality.

## Run locally

### Requirements

- Python 3.12
- Node.js 20.19 or newer (or Node.js 22.12+)
- npm

### Fastest path

The repository includes a versioned SQLite universe snapshot, so you can run the existing world without collecting data first.

```bash
git clone https://github.com/andy6609/git-galaxy.git
cd git-galaxy

python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt "uvicorn[standard]"

npm --prefix web ci
npm --prefix web run build

.venv/bin/uvicorn server.app:app --port 8787
```

Open [http://localhost:8787](http://localhost:8787).

### Development mode

Run the API and Vite development server in separate terminals:

```bash
# Terminal 1: API
.venv/bin/uvicorn server.app:app --reload --port 8787

# Terminal 2: web client
npm --prefix web run dev
```

Open [http://localhost:5173](http://localhost:5173). Vite proxies `/api` requests to port `8787`.

### Optional environment variables

Copy `.env.example` or export variables in your shell:

```bash
# Use Postgres/Supabase instead of the local SQLite ledger.
POSTGRES_URL=postgresql://...

# Increase GitHub API capacity for accounts added through search.
GITHUB_TOKEN=github_pat_...
```

Never expose either value to the browser. Both are server-only credentials.

## How account ingestion works

Git Galaxy does not attempt to crawl all of GitHub in advance.

1. The client resolves a username, repository, URL, or package against the existing ledger.
2. If a valid username is missing, the API reads its public repositories from GitHub.
3. When GitHub is unavailable or rate-limited, the importer can fall back to ecosyste.ms.
4. A fixed placement model finds related accounts and chooses an unoccupied nearby position.
5. The API records the final coordinates. Later metadata changes do not move the system.

Without `GITHUB_TOKEN`, GitHub's anonymous API limit is shared by ingestion requests. A token raises the limit, but is not required to browse the existing universe.

## Architecture

```text
GitHub / ecosyste.ms / deps.dev
              │
              ▼
       collection pipeline
              │
       relationship + layout
              │
              ▼
   persistent coordinate ledger
      SQLite locally / Postgres
              │
              ▼
          FastAPI API
              │
              ▼
 React + React Three Fiber + Three.js
```

| Area | Main files | Responsibility |
|---|---|---|
| Web client | `web/src/` | Search, navigation state, camera transitions, planets, star systems, and UI |
| API | `server/app.py` | World snapshot, system details, search resolution, suggestions, and lazy ingestion |
| Database adapter | `server/database.py` | SQLite for local development, Postgres when `POSTGRES_URL` exists |
| Data pipeline | `pipeline/` | Collect accounts, derive relationships, create communities, and generate stable placement data |
| Postgres schema | `supabase/migrations/` | Server-only ledger tables and access restrictions |
| Experiments | `docs/experiments/` | Visual studies, evaluation notes, and screenshots behind design decisions |

## API reference

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/world` | Galaxies, regions, star systems, minimal planet data, sources, and observation statistics |
| `GET` | `/api/system/{account_id}` | One account, its repository metadata, and incoming/outgoing routes |
| `GET` | `/api/resolve?q=...` | Resolve a username, repository, GitHub URL, or package to a destination |
| `GET` | `/api/suggest?q=...` | Return up to six account and repository suggestions |
| `POST` | `/api/ingest/{login}` | Add a missing public GitHub account to the persistent universe |

Username ingestion accepts GitHub-compatible names up to 39 characters. Failed lookups are cached briefly to avoid repeatedly hitting upstream APIs.

## Build and checks

```bash
# Type-check and create a production web build
npm --prefix web run build

# Run the browser flow smoke check while the local app is running
npm --prefix web run check

# Capture experiment screenshots
npm --prefix web run shot -- shots/
```

The screenshot and smoke-check scripts use a local Chrome or Chromium installation through Puppeteer Core.

## Rebuild the universe

You do not need this step to run the included snapshot. Use it when working on collection or placement:

```bash
.venv/bin/pip install umap-learn
.venv/bin/python pipeline/collect.py
.venv/bin/python pipeline/accounts.py
.venv/bin/python pipeline/universe.py
```

API responses and intermediate files are cached under ignored paths in `data/raw/` and `data/build/`. The canonical SQLite ledger and fixed placement model are versioned. `pipeline/universe.py` refuses to replace an existing ledger unless you explicitly pass `--reset`.

To import the checked-in universe into an empty Supabase/Postgres database:

```bash
POSTGRES_URL_NON_POOLING=postgresql://... \
  .venv/bin/python scripts/import_sqlite_to_postgres.py
```

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the Vercel and Supabase deployment flow.

## Contributing

Contributions are welcome, especially in these areas:

- making planet silhouettes easier to recognize
- improving camera travel and system-to-system discovery
- improving keyboard, touch, reduced-motion, and screen-reader behavior
- making placement quality measurable and reproducible
- adding synthetic fixtures and automated tests
- reducing rendering cost on mobile and integrated GPUs

Before opening a pull request:

1. Create a focused branch.
2. Keep repository coordinates deterministic and preserve existing ledger entries.
3. Do not invent dependency routes or turn missing data into zero.
4. Run `npm --prefix web run build`.
5. Include before/after screenshots for visible changes.
6. Explain which user experience or data invariant the change protects.

For larger product or data-model changes, read [docs/DIRECTION.md](docs/DIRECTION.md) first and open an issue before investing in a large implementation.

## Data and attribution

- [ecosyste.ms](https://ecosyste.ms) supplies package and repository metadata. Derived universe data is distributed under **CC BY-SA 4.0**.
- [deps.dev](https://deps.dev) supplies dependency information for supported package ecosystems.
- The [GitHub REST API](https://docs.github.com/en/rest) supplies public account and repository metadata for explicitly included or searched accounts.

A public repository is not automatically open source. Git Galaxy keeps license status as separate metadata and does not present an unknown license as permission to reuse code.

## Project status and license

Git Galaxy is a prototype under active development. APIs, visuals, placement versions, and stored data may change.

The derived universe dataset is covered by **CC BY-SA 4.0** as noted above. A license for this repository's source code has not yet been added, so do not assume permission to copy, modify, or redistribute the code until a license file is published.

## Documentation

| Document | What it contains |
|---|---|
| [Product plan](docs/PLAN.md) | Original product vision and long-term system design |
| [Direction log](docs/DIRECTION.md) | Current decisions and the reasoning behind them; takes precedence over the original plan |
| [Prototype specification](docs/PROTOTYPE_SPEC.md) | Prototype scope, experiments, and pass/fail criteria |
| [Product review](docs/PRODUCT_REVIEW.md) | User-flow and presentation review |
| [Exploration-flow review](docs/EXPLORATION_FLOW_REVIEW.md) | Search, travel, arrival, and onward-discovery audit |
| [Deployment guide](docs/DEPLOYMENT.md) | Vercel, Supabase, schema migration, and data import |
| [Experiment log](docs/experiments/) | Visual evidence and design experiments |

---

<div align="center">

**A repository can be small and still be a place worth visiting.**

</div>
