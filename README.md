# Lily

Synced memory bank for `lily.aolabs.io`.

The public front end is served by GitHub Pages. Shared notes, screenshots, photos, extracted image text, and chat answers are handled by the Railway API service.

User-added data is stored on the Railway `lily-api` service in its persistent `/data` volume. The PIN is checked by the API before memory or media can be read or changed.

## Run Locally

```bash
npm start
```

Open `http://localhost:3000`.

Set `public/config.js` to an empty API base for same-origin local API testing, or to the Railway API URL when testing the GitHub Pages front end against production.

## API

- `POST /api/auth` - verify 4 digit PIN and return an API token
- `GET /api/memories` - list shared memories
- `POST /api/memories` - save notes and image data
- `DELETE /api/memories/:id` - delete a saved memory
- `POST /api/chat` - answer from saved Lily context

Railway variables:

- `DATA_DIR=/data`
- `LILY_PIN=6699`
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
