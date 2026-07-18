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
- `GET /api/weights` - list saved weight records
- `POST /api/weights` - save a weight with the server timestamp
- `DELETE /api/weights/:id` - delete a saved weight record
- `GET /api/tracker` - read conflict, longest streak, and period tracker counts
- `POST /api/tracker/conflict` - save a conflict event; an authenticated backfill may include a past `dateKey`
- `POST /api/tracker/period` - save a period start; an authenticated backfill may include a past `dateKey`
- `PATCH /api/tracker/:id` - save reported period-end, high-desire, and possible-ovulation-window dates on a period entry; the high-desire offset predicts future cycle dates
- `DELETE /api/tracker/:id` - delete a saved conflict or period entry
- `POST /api/chat` - answer from saved Lily context

## Weight forecast

The chart calculates one one-year endpoint baseline for every saved daily weigh-in, using only that date and the dates before it. Multiple entries on one local date are reduced to their median. The estimate model-averages a recent-weight baseline with robust damped-trend candidates, weighted by true walk-forward errors at every available 7-, 14-, and 28-day horizon. Trend persistence is capped at `phi <= 0.98`, and outlier clipping uses the latest 30 forecast errors, so short-term scale noise is not extended as a straight line for all 365 days while long histories remain responsive. The current headline and the final overlay point share the exact same calculated value.

Until real measurements exist for at least 20 completed 365-day forecast origins spaced at least 28 days apart, the UI calls the result an uncalibrated `1-year baseline`, provides no made-up error band, and explicitly says it estimates one future date rather than every day of the year. Once that minimum exists, the result may show an empirical historical-error band but is still not called validated or guaranteed. A biological body-weight forecast would also require inputs such as diet, activity, metabolism, and body composition, and Lily does not currently collect those inputs.

The visible summary stays to one compact values line plus two plain caveats. Walk-forward and annual-calibration details remain in the chart semantics and verification output rather than crowding the primary weight readout.

Method references: [damped-trend forecasting](https://doi.org/10.1287/mnsc.31.10.1237), [robust Holt-Winters filtering](https://doi.org/10.1002/for.1125), [rolling-origin forecast evaluation](https://doi.org/10.1016/S0169-2070(00)00065-0), and the [NIDDK body-weight model research](https://www.niddk.nih.gov/research-funding/at-niddk/labs-branches/laboratory-biological-modeling/integrative-physiology-section/research/body-weight-planner).

Railway variables:

- `DATA_DIR=/data`
- `LILY_PIN=<private PIN>`
- `SESSION_SECRET`
- `OPENAI_API_KEY`
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
