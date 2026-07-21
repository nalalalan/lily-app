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
- `GET /api/weights` - list saved weight records plus the latest persisted coach paragraph
- `POST /api/weights` - save a weight and its persisted coach paragraph with the server timestamp
- `DELETE /api/weights/:id` - delete a saved weight record
- `GET /api/tracker` - read conflict, longest streak, and period tracker counts
- `POST /api/tracker/conflict` - save a conflict event; an authenticated backfill may include a past `dateKey`
- `POST /api/tracker/period` - save a period start; an authenticated backfill may include a past `dateKey`
- `PATCH /api/tracker/:id` - save reported period-end, high-desire, and possible-ovulation-window dates on a period entry; the high-desire offset predicts future cycle dates
- `DELETE /api/tracker/:id` - delete a saved conflict or period entry
- `POST /api/chat` - answer from saved Lily context

## Weight trend outlook and coach

The one-year trend outlook calculates one point for every calendar-day median using only the measurements available through that date. The existing causal annual target remains bounded by the robust walk-forward model and momentum diagnostics. The displayed annual series has no retained velocity: confirmed multi-reading evidence moves 30% toward the current target with a 2 lb cap, while weak, flat, isolated, or reversal evidence moves 25% with a 0.75 lb cap. Every step moves toward its current target without overshoot. The current headline exactly matches the final plotted point.

Every weigh-in first persists a deterministic, contextual 35–55-word fallback paragraph. Model generation happens outside the write lock, uses only selected source facts, and is accepted only after deterministic validation plus a second critic pass. Invalid numbers, unsafe advice, sensitive tracker context, repetition, multiline output, timeouts, and private-strategy leakage retain the safe fallback. Public weight responses expose only `latestCoach: { weightId, text, createdAt }`; evidence references and generation metadata stay in the private store.

The weight card is ordered for one screenshot: latest weight and compact outlook, one coach paragraph, actual weight versus time, one-year trend outlook versus time, then the entry form. The actual chart uses only measured weights and their robust trend. The outlook chart has its own scale and directly labels its current value and direction. Photos, videos, tracker history, bottom weight history, delete controls, and the centered media/right-rail layout remain separate and preserved.

Method references: [damped-trend forecasting](https://doi.org/10.1287/mnsc.31.10.1237), [robust Holt-Winters filtering](https://doi.org/10.1002/for.1125), [rolling-origin forecast evaluation](https://doi.org/10.1016/S0169-2070(00)00065-0), and the [NIDDK body-weight model research](https://www.niddk.nih.gov/research-funding/at-niddk/labs-branches/laboratory-biological-modeling/integrative-physiology-section/research/body-weight-planner).

Railway variables:

- `DATA_DIR=/data`
- `LILY_PIN=<private PIN>`
- `SESSION_SECRET`
- `OPENAI_API_KEY`
- `LILY_INTERNAL_GOAL_LB=<private server-only value>`
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
