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
- `POST /api/weights` - durably save a weight with the server timestamp, award any newly crossed boba thresholds once, then attach its persisted coach paragraph without allowing coach validation or generation to roll back the measurement
- `DELETE /api/weights/:id` - delete a saved weight record
- `GET /api/tracker` - read conflict, longest streak, and period tracker counts
- `POST /api/tracker/conflict` - save a conflict event; an authenticated backfill may include a past `dateKey`
- `POST /api/tracker/period` - save a period start; an authenticated backfill may include a past `dateKey`
- `PATCH /api/tracker/:id` - save period details and explicit reported upcoming period/high-desire dates on a real period entry; reported upcoming dates override the estimate without becoming future actual events
- `DELETE /api/tracker/:id` - delete a saved conflict or period entry
- `POST /api/chat` - answer from saved Lily context

## Weight trend outlook and coach

The boba baseline is the exact mean of the available America/New_York daily-median weights in the inclusive Aug 2-8, 2026 calendar window. Missing days are not filled in. The store retains the exact baseline, source window, observed dates, and count while the authenticated response and memo use one-decimal display values. Each whole pound below the baseline is a one-time threshold; a saved weigh-in can earn every newly passed threshold, but reads, restarts, deletions, later rises, and re-crossings cannot mint or duplicate a reward. Earned events retain their level, exact threshold, seven-day average, timestamp, and triggering weight ID.

The one-year trend outlook calculates one point for every calendar-day median using only the measurements available through that date. The existing causal annual target remains bounded by the robust walk-forward model and momentum diagnostics. The displayed annual series has no retained velocity: confirmed multi-reading evidence moves 30% toward the current target with a 2 lb cap, while weak, flat, isolated, or reversal evidence moves 25% with a 0.75 lb cap. Every step moves toward its current target without overshoot. The current headline exactly matches the final plotted point.

Every finalized weigh-in memo contains one source-bound personal context clause in addition to the weight analysis and exactly one health action. The initial deterministic fallback uses a substantial safe meaning reduced from authenticated Lily context; final generation may retain that clause or replace it with a stronger eligible private detail. A generic food action, a media shell, a date shell, or a vague claim that private context exists cannot satisfy the context gate. The verdict and weight evidence lead. Private source and author provenance stay out of visible copy: the safe content is stated directly (`The research-figure panels need to line up...`) instead of being wrapped in narration about a mind, thought, distraction, memory, Brain, note, source, or retrieval. The clause is woven into the analysis and followed by more weight evidence, never presented as a standalone receipt. A literal-only compositional reducer preserves safe concrete subjects such as violins and safe intents from unfamiliar inputs without copying arbitrary names, private details, or raw phrases. A saved weight always receives a persisted, validator-passing analysis for that exact weight. If richer personal context is temporarily unavailable, the server uses a repairable emergency analysis and later reconciles the newest safe context without exposing `Coach message unavailable`. Public weight responses expose only `latestCoach: { weightId, text, createdAt }`; evidence references, reduced-context provenance, and generation metadata stay in the private store.

Weight persistence is the primary operation and coaching is a recoverable derivative. A fallback-builder, model, critic, or validator failure cannot reject or roll back a valid weigh-in, and server-side invariant details never enter API error bodies or browser toasts.

Coach language stays warm, clear, hopeful, and low-overwhelm while keeping the data verdict unmistakable. Worsening evidence is framed as a result that needs a reset, never as rejection of Lily; every paragraph preserves agency, avoids alarmist all-caps or coercive pressure, and gives exactly one doable action. Private health or diagnostic context is not copied into messages, APIs, logs, source constants, Spec, Progress, or papers. The coach supports sustainable momentum rather than promoting rapid-loss promises, fasting, meal skipping, restriction, or compensatory exercise.

A recent direct note reporting Lily's own safe hydration, vegetable, protein, or comfortable-movement effort can tailor one current or next coach action. The server maps the note to an approved semantic action without sending or echoing its raw text, records the memory reference, refreshes only a timely latest coach record, and consumes transient reactions once. Saved reactions never alter verdicts, weight evidence, forecasts, charts, or earlier coach records; unrelated, stale, sensitive, medical, or unsafe notes remain stored but are excluded from coaching.

A recent note can also carry one explicitly attributed, non-clinical observation that Alan noticed Lily seems off and wants her to feel seen. That observation may add one warm acknowledgment plus one easy, safe action to the timely current or next coach message. It does not claim a conflict caused her mood, diagnose her, soften the weight verdict, or change any forecast; the raw note remains private to the memory store and the acknowledgment is consumed after one use.

Every authenticated Alan input in Brain or Lily is treated as authentic source material regardless of age, metadata shape, emotional content, quoted material, or mixed sensitive clauses. Eligibility applies to the reduced visible meaning, not to the source's authenticity: the server reduces the newest safe source into a bounded, source-specific subject such as the actual figure, app, game, song, meal, cat, language, trip, hydration effort, cycle context, mood observation, repair attempt, or the trust represented by a long unfiltered thought. Only that sanitized clause and opaque provenance reach the coach pipeline; the complete raw note, sensitive details, diagnoses, sexual material, third-party content, and private fears never enter the coach prompt, public API, logs, or visible memo. Recency ranks candidate relevance but does not invalidate older source material.

The same opaque source ID is cooled down across the prior three memos, and Lily memory meanings still rotate; a genuinely new Brain entry is not discarded merely because it shares a broad topic with an older one. When every eligible source is on cooldown, the newest safe anchor remains available as a last resort and rotates to a different approved detour instead of publishing a context-free memo. Outside one strictly supported adjacent relationship letter, the newest eligible Brain or Lily source wins by actual source timestamp. The six-hour lookback and five-minute indexing grace apply only to strict relationship-letter priority. A generic Brain thought stays eligible through the current operational time while the latest weigh-in remains inside the bounded 48-hour refresh window, including a thought saved more than five minutes after that weigh-in. Bounded read and scheduled/read reconciliation replace an older current anchor when the newer source appears. Personal context cannot alter the verdict, evidence, action, forecast, chart geometry, or public API shape.

The writer uses the stronger checked model to produce three fresh assemblies from closed, approved factual components instead of selecting an exact paragraph from a canned enum. Deterministic validation still owns every number, evidence relation, verdict family, one-action rule, safety rule, and personal clause; the critic may evaluate the one or more candidates that survive those gates instead of discarding a valid original paragraph because a sibling failed. A semantic argument-frame fingerprint rejects the same verdict-current-evidence-outlook-context-action sequence even when its numbers and surface wording change; deterministic fallbacks use genuinely different role orders and the identical gate. The writer request no longer demands three distinct action sentences when the approved action family supplies fewer than three, removing an impossible constraint that previously forced valid live reads into fallback.

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
