# Lily

Synced memory bank for `lily.aolabs.io`.

The public front end is served by GitHub Pages. Shared notes, screenshots, photos, videos, extracted image text, and chat answers are handled by the Railway API service.

User-added data is stored on the Railway `lily-api` service in its persistent `/data` volume. The PIN is checked by the API before memory or media can be read or changed.

## Run Locally

```bash
npm start
```

Open `http://localhost:3000`.

Set `public/config.js` to an empty API base for same-origin local API testing, or to the Railway API URL when testing the GitHub Pages front end against production.

## API

- `POST /api/auth` - verify the configured PIN and return an API token
- `GET /api/memories` - list shared memories
- `POST /api/memories` - save notes, image data, and video data
- `DELETE /api/memories/:id` - delete a saved memory
- `GET /api/weights` - list saved weight records plus the latest persisted coach paragraph and current boba reward progress
- `POST /api/weights` - detect an automatic kg/lb input (or honor an explicit `kg`/`lb` override), convert it to two-decimal pounds, durably save it as `unit: "lb"`, award any newly crossed boba thresholds once, then attach its persisted memo without allowing memo creation to roll back the measurement
- `DELETE /api/weights/:id` - delete a saved weight record
- `GET /api/tracker` - read conflict, longest streak, and period tracker counts
- `POST /api/tracker/conflict` - save a conflict event; an authenticated backfill may include a past `dateKey`
- `POST /api/tracker/period` - save a period start; an authenticated backfill may include a past `dateKey`
- `PATCH /api/tracker/:id` - save period details and explicit reported upcoming period/high-desire dates on a real period entry; reported upcoming dates override the estimate without becoming future actual events
- `DELETE /api/tracker/:id` - delete a saved conflict or period entry
- `POST /api/chat` - answer from saved Lily context

## Weight trend outlook and coach

The browser and server share one detector. With history, both the pound and kilogram interpretations are compared with the median of the latest seven daily weights; without history, values below 100 are kilograms and values at or above 100 are pounds. A clear kilogram input previews its pound conversion before save. A genuinely ambiguous value requires an explicit kg/lb choice. Saved records, API responses, latest weight, history, charts, forecasts, memos, and rewards use pounds. Legacy kilogram records are converted when read and calculated without changing their stored IDs or timestamps.

The boba baseline is the exact mean of the available America/New_York daily-median weights in the inclusive Aug 2-8, 2026 calendar window. Missing days are not filled in. The store retains the exact baseline, source window, observed dates, and count while the authenticated reward display rounds the current average to one decimal. The first reward target rounds the prior exact one-pound-lower target down to a whole pound (149 lb for the 150.325 lb baseline); later one-time targets are 148 lb, 147 lb, and so on. A saved weigh-in can earn every newly passed threshold, but reads, restarts, deletions, later rises, and re-crossings cannot mint or duplicate a reward. Earned events retain their level, exact threshold, seven-day average, timestamp, and triggering weight ID.

The one-year trend outlook calculates one point for every calendar-day median using only the measurements available through that date. The existing causal annual target remains bounded by the robust walk-forward model and momentum diagnostics. The displayed annual series has no retained velocity: confirmed multi-reading evidence moves 30% toward the current target with a 2 lb cap, while weak, flat, isolated, or reversal evidence moves 25% with a 0.75 lb cap. Every step moves toward its current target without overshoot. The current headline exactly matches the final plotted point.

Each saved weigh-in gets one deterministic server-written memo of two or three sentences and no more than 42 words. It leads with the current pound weight, immediate change, and one decisive seven-day fact or contrast; gives exactly one safe, manageable action; and may end with a brief encouragement or one current boba fact. The detailed forecast and boba window remain in their dedicated displays instead of being repeated in the memo.

Personal context is optional. At most one already-approved safe detail may appear when it naturally improves the action or encouragement and still fits the word cap; omission is normal and never triggers a delayed rewrite. The memo has no role prefix, source wrapper, model/critic stage, slogan pool, forced transition, novelty padding, or arbitrary personal detour. It stays warm and direct while avoiding rapid-loss promises, fasting, meal skipping, restriction, compensatory exercise, diagnoses, or other sensitive detail. Public responses expose only `latestCoach: { weightId, text, createdAt }`; private analysis metadata stays private.

Weight persistence is the primary operation and memo composition is a recoverable derivative. A memo failure cannot reject or roll back a valid weigh-in, and server-side invariant details never enter API error bodies or browser toasts.

The weight card is ordered for one screenshot: latest weight and compact outlook, one coach paragraph, actual weight versus time, one-year trend outlook versus time, then the entry form. The actual chart uses only measured weights and their robust trend. The outlook chart has its own scale and directly labels its current value and direction. Photos, videos, tracker history, bottom weight history, delete controls, and the centered media/right-rail layout remain separate and preserved.

Method references: [damped-trend forecasting](https://doi.org/10.1287/mnsc.31.10.1237), [robust Holt-Winters filtering](https://doi.org/10.1002/for.1125), [rolling-origin forecast evaluation](https://doi.org/10.1016/S0169-2070(00)00065-0), and the [NIDDK body-weight model research](https://www.niddk.nih.gov/research-funding/at-niddk/labs-branches/laboratory-biological-modeling/integrative-physiology-section/research/body-weight-planner).

Railway variables:

- `DATA_DIR=/data`
- `LILY_PIN=<private PIN>`
- `SESSION_SECRET`
- `OPENAI_API_KEY`
- `LILY_INTERNAL_GOAL_LB=<private server-only value>`
- `BRAIN_API_BASE=<private Brain service base URL>`
- `LILY_BRAIN_TIMEOUT_MS=2000`
- `ALLOWED_ORIGINS=https://lily.aolabs.io,http://localhost:3000,http://127.0.0.1:3000`

## Deploy To GitHub Pages

The live site is served from the `gh-pages` branch with the custom domain `lily.aolabs.io`.

1. Commit changes on `main`.
2. Copy the updated `public` files into the `gh-pages` deployment worktree.
3. Commit and push `gh-pages`.

## Deploy API To Railway

The Railway project is `lily-app`, service `lily-api`.

```bash
railway up --detach
```

The production API base is `https://lily-api-production.up.railway.app`.
