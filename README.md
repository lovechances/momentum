# Momentum

Local-first personal execution PWA. App data and evidence blobs are stored in browser IndexedDB; no account, telemetry, or cloud data store is used.

## Run

Momentum targets Node 24. With `nvm`, run `nvm use`; otherwise select a Node 24 installation before continuing.

`npm ci && npm run dev`

Checks: `npm run typecheck`, `npm run lint`, `npm run test`, `npm run build`.

## Deployment and AI

Deploy the repository to Vercel as a Vite app. Optional AI uses `/api/ai`; set `OPENAI_API_KEY` only in Vercel environment variables. For local AI-route testing, use `vercel dev` with the key in `.env.local`; plain `vite` development serves the offline-first app but does not execute Vercel Functions. The frontend never contains that key. AI is explicit-only and remains unavailable without the server variable.

Never rename the server key with a `VITE_` prefix. `.env.local` is ignored; `.env.example` documents the variable name without a value.

## Notifications

The app implements deterministic in-app reminders while it is open. V1 does not request notification permission or claim to schedule background alerts: reliable alerts while the app is closed would require a push service, which this local-first release deliberately does not add.

## Backup

Settings → Data exports a full JSON backup including compressed media encoded inside the file. Keep that file private. Import validates the schema before changing local app state.
