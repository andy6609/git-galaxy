# Handoff: landing page appears missing on Vercel

Status: **fixed and verified locally (2026-09-28)**: `npm --prefix web run build` and `npm --prefix web run check` (14/14) pass. With `/api/world` held for 5 s, the hero, input, and CTA render about 150 ms after navigation on both `/` and `/?u=andy6609`. The check now waits 1 s before reading the hero's opacity, so the 0.12 s + 0.7 s entrance animation no longer makes it fail spuriously.

This document is intended to let the next Claude/Codex session continue without reconstructing the investigation.

## User report

Opening [https://git-galaxy-bice.vercel.app/](https://git-galaxy-bice.vercel.app/) appeared not to show the main “make your GitHub” landing page.

The intended English-first landing headline is currently:

> Your GitHub becomes a small universe.

The production page eventually displayed the headline, search field, CTA, observation information, and Korean language switch. The actual failure is the first-load experience: during a slow `/api/world` response or Vercel cold start, the screen can remain at `Loading observations` long enough to look broken. Even after the response arrives, CSS intentionally kept the hero invisible for another 2.6 seconds.

Production URL: `https://git-galaxy-bice.vercel.app/`

Relevant deployed baseline commit: `cca94e1 feat: add English-first bilingual interface`

## Confirmed root cause

Two delays were stacked:

1. In `web/src/App.tsx`, `<Search>` and `<LanguageSwitch>` were rendered only inside `world && !view`. The landing UI therefore did not exist until the large `/api/world` request completed.
2. In `web/src/styles.css`, `.search.is-intro` used `animation: rise 1.2s 2.6s both`, hiding the landing UI for an additional 2.6 seconds.

This is particularly visible on the first production request, slow networks, and serverless cold starts. It is not primarily a Vercel routing failure.

## Local fix already applied

There are four modified source/test files in the working tree. **Do not discard these changes.**

- `web/src/App.tsx`
  - Renders `<Search>` and `<LanguageSwitch>` whenever `!view`, without waiting for `world`.
  - Keeps world-dependent overlays gated behind `world && !view`.
  - Keeps the old centered loading screen only for special views that require world data.
- `web/src/ui/Search.tsx`
  - Accepts `World | null` and an optional load error.
  - Displays loading/error status below the form while world data is unavailable.
  - Disables submission until the world is loaded.
  - Avoids suggestions and navigation before data is ready.
- `web/src/styles.css`
  - Reduces the intro delay from 2.6 seconds to 0.12 seconds and shortens the rise animation.
- `web/scripts/check.mjs`
  - Adds a regression check that intercepts `/api/world` and verifies the hero is visible before releasing that request.
  - Updates an older Korean-only plate assertion to expect the English-first `Orbit` label.

Current expected `git status --short`:

```text
 M web/scripts/check.mjs
 M web/src/App.tsx
 M web/src/styles.css
 M web/src/ui/Search.tsx
?? git_galaxy.egg-info/
```

`git_galaxy.egg-info/` is unrelated, pre-existing generated material. **Do not stage, edit, or delete it.**

## Verification completed

The following passed after applying the local fix:

```bash
npm --prefix web run build
```

TypeScript and the Vite production build completed successfully. The existing bundle-size warning (`>500 kB`) remains and is unrelated to this incident.

## Verification still required

The full browser smoke check was not run. Starting the local API required approval and that approval was interrupted/rejected when the prior session ended.

Continue from here:

1. Inspect `git diff` and preserve the four edits listed above.
2. Start the Python API using the repository virtual environment:

   ```bash
   .venv/bin/uvicorn server.app:app --host 127.0.0.1 --port 8787
   ```

3. Start Vite on the port expected by the smoke script:

   ```bash
   npm --prefix web run dev -- --host 127.0.0.1 --port 5173
   ```

4. Run the full smoke test:

   ```bash
   npm --prefix web run check
   ```

5. If the new interception test fails, inspect `web/scripts/check.mjs` first. The application fix should not be reverted merely to satisfy the test.
6. Manually verify both `/` and `/?u=andy6609` with a delayed `/api/world` response.
7. Commit only the intended four code/test files plus this handoff document. Do not include `git_galaxy.egg-info/`.
8. Push `main`, wait for Vercel deployment, and verify the production URL with a fresh session/cache.

## Acceptance criteria

- The headline, explanatory copy, input, and CTA appear before `/api/world` resolves.
- A loading message is visible beneath the form while world data is pending.
- The CTA cannot submit until world data is ready, but the user can see and type into the field.
- When the response arrives, the landing UI is not duplicated and does not replay a long entrance delay.
- Search/navigation still works for `/`, `/?u=andy6609`, suggestions, and GitHub repository URLs.
- English remains the default; the small Korean switch still works and persists through `gg-language`.
- `npm --prefix web run build` and `npm --prefix web run check` pass.
- The deployed base URL presents the landing UI immediately during a cold or slow API response.

## Potential test detail

The new regression test pauses the `/api/world` Puppeteer request and stores a `releaseWorld` callback. Review request cleanup if the test hangs or reports an already-handled request. This JavaScript smoke test is not type-checked by the Vite build, so the successful build alone does not validate it.

## Paste-ready continuation prompt

> Read `docs/HANDOFF_LANDING_PAGE_LOADING.md` first. Preserve the current uncommitted working-tree fix and do not touch `git_galaxy.egg-info/`. Continue at “Verification still required”: run the local API and Vite app, execute the complete browser check, repair only genuine failures, commit the four intended code/test changes plus the handoff document, push `main`, wait for Vercel, and verify that the landing hero is visible before `/api/world` resolves on the production URL.
