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

## Weight forecast and coach

The prediction history calculates a one-year target for every saved daily weigh-in, using only that date and the dates before it. Multiple entries on one local date are reduced to their median. A robust walk-forward ensemble supplies the stable component. A bounded momentum layer then reacts strongly to the current story: Theil-Sen slopes over the latest 3 points and 7/14 calendar days, plus a valid same-direction streak, drive a decaying 48-day adjustment capped at `0.5 lb/day`. Horizon bounds around the latest three-weight median are 4% for a week, 8% for a month, and 20% for a year, with absolute minimum bounds of 4, 8, and 20 lb. A lone implausible jump cannot activate strong momentum.

The visible predictions keep those aggressive raw targets but reach them through a causal velocity layer. The robust 3/7/14-day direction is smoothed, the annual target can still swing by as much as 35 lb inside the existing horizon bounds, and retained velocity makes the displayed line bend before reversing. Per-weigh-in desired velocity is capped at 1.5 lb for one week, 2.5 lb for one month, and 4 lb for one year. Sustained evidence can keep driving the call toward an extreme; one noisy point cannot teleport it by 20–30 lb. The final displayed annual value is shared exactly by the headline and the last prediction-history point.

The primary card shows one direct `1 wk · 1 mo · 1 yr` line and a short pattern-specific coach read. Every saved weigh-in gets unmistakable, data-specific energy: improving direction becomes emphatic celebration; worsening direction becomes a fired-up rally with a practical next move; and flat, noisy, mixed, outlier, or single-bump data becomes an animated reset, challenge, or suspense read. The coach counts the real streak and change, remembers the run immediately preceding a reversal, and varies its sentence structure as the saved pattern changes. It does not shame Lily, invent behavior, imply clinical credentials, recommend extreme restriction, or infer obesity or health status from pounds alone.

Actual weight and one-year prediction history render in two separate charts with independent y-domains. The actual chart comes first, labels and emphasizes the latest saved weight, and includes only measured weights plus their trend; prediction values cannot flatten it. The second chart contains only the connected, causal annual prediction history. Walk-forward errors, annual outcomes, raw targets, base-model values, momentum diagnostics, and continuity state remain available to tests and diagnostics without becoming a caveat wall in the card.

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
