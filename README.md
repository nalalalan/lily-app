# Lily

Static memory bank for `lily.aolabs.io`.

The app is a media-first wall with a browser PIN gate. User-added photos, quotes, dates, addresses, phone numbers, and notes are stored locally in the browser using IndexedDB and localStorage. They are not committed into the repository or synced across devices.

## Run Locally

```bash
npm start
```

Open `http://localhost:3000`.

## Deploy To GitHub Pages

The live site is intended to be served from the `gh-pages` branch with the custom domain `lily.aolabs.io`.

1. Commit changes on `main`.
2. Copy the updated `public` files into the `gh-pages` deployment worktree.
3. Commit and push `gh-pages`.

The DNS record for `lily.aolabs.io` must point to `nalalalan.github.io` before the custom domain can resolve.
