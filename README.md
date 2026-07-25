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

Every weigh-in first persists a deterministic, contextual 35–55-word fallback paragraph. A one-use relationship-support sentence may extend a timely memo to 45–80 words. Model generation happens outside the write lock, uses only selected source facts, and is accepted only after deterministic validation plus a second critic pass. Invalid numbers, unsafe advice, sensitive tracker context, repetition, multiline output, timeouts, and private-strategy leakage retain the safe fallback. Public weight responses expose only `latestCoach: { weightId, text, createdAt }`; evidence references and generation metadata stay in the private store.

Coach language stays warm, clear, hopeful, and low-overwhelm while keeping the data verdict unmistakable. Worsening evidence is framed as a result that needs a reset, never as rejection of Lily; every paragraph preserves agency, avoids alarmist all-caps or coercive pressure, and gives exactly one doable action. Private health or diagnostic context is not copied into messages, APIs, logs, source constants, Spec, Progress, or papers. The coach supports sustainable momentum rather than promoting rapid-loss promises, fasting, meal skipping, restriction, or compensatory exercise.

A recent direct note reporting Lily's own safe hydration, vegetable, protein, or comfortable-movement effort can tailor one current or next coach action. The server maps the note to an approved semantic action without sending or echoing its raw text, records the memory reference, refreshes only a timely latest coach record, and consumes transient reactions once. Saved reactions never alter verdicts, weight evidence, forecasts, charts, or earlier coach records; unrelated, stale, sensitive, medical, or unsafe notes remain stored but are excluded from coaching.

A recent note can also carry one explicitly attributed, non-clinical observation that Alan noticed Lily seems off and wants her to feel seen. That observation may add one warm acknowledgment plus one easy, safe action to the timely current or next coach message. It does not claim a conflict caused her mood, diagnose her, soften the weight verdict, or change any forecast; the raw note remains private to the memory store and the acknowledgment is consumed after one use.

A recent Alan-authored Brain entry may contribute one short, pre-approved sentence of authentic boyfriend connection to a timely memo when it contains either an explicit relationship-safe letter or a safe first-person signal of Alan's ordinary unfiltered yapping. Eligibility is limited to Brain's own generated-note provenance; uploads, transcripts, quoted material, sensitive generic yaps, and unrelated files cannot masquerade as Alan's voice. The server immediately reduces the source to a fixed semantic cue and never sends, persists, logs, or exposes the raw entry. Sensitive details, diagnoses, sexual material, breakup fears, conditional affection, and weight-linked relationship claims are ineligible. One Brain source can appear in only one memo and cannot alter the verdict, evidence, action, forecast, chart geometry, or public API shape. Because Brain processing can finish after the weigh-in request, Lily accepts only a bounded six-hour lookback and five-minute post-weight indexing grace, retries across that full window on the server, quietly refreshes the visible memo in the browser, replaces an earlier provisional cue when a newer adjacent entry arrives, and repairs missed current context during authenticated weight reads. Brain downtime leaves the ordinary evidence-first coach path unchanged.

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
