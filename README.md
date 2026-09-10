# FieldTrail — PWA

An installable Progressive Web App version of the FieldTrail lead & live-location
tracking prototype (Admin dashboard + Salesman flow), built with React + Vite.

This is the **standalone demo build**: all data (salesmen, leads, live movement)
is simulated in-memory, and lead capture uses your device's **real GPS** via the
browser Geolocation API. There's no server — swap in the real backend later by
replacing the state in `src/App.jsx` with calls to your API (a matching
Node/Postgres backend design is in the architecture doc you already have).

## What makes it a PWA (not just a page)

- **Installable** — has a web app manifest + icons, so it can be added to the
  home screen on Android/desktop Chrome (native "Install" prompt, captured by
  the in-app **Install** button) and iOS Safari (Share → Add to Home Screen).
- **Runs standalone** — no browser chrome once installed; respects the phone's
  notch/home-indicator safe areas.
- **Offline-capable app shell** — a service worker (via `vite-plugin-pwa`,
  Workbox under the hood) precaches the app so it opens even with no signal.
- **Offline-first lead capture** — if you save a lead while offline, it's
  tagged `queued` (mirroring the real product's client-UUID sync design) and
  flips to `synced` automatically the moment the device reconnects. The top
  bar shows an OFFLINE / SYNCING indicator.
- **Auto-updating** — new deployments are picked up silently on next launch,
  no manual "update the app" step for field staff.

## Run it locally

```bash
npm install
npm run dev
```

Open the printed local URL. Note: `beforeinstallprompt` / full install
behavior, and background-tab GPS permission prompts, are easiest to test over
**HTTPS** or on `localhost` (both count as a "secure context").

## Build for production

```bash
npm run build
npm run preview   # serves the production build locally to sanity-check it
```

The build output lands in `dist/` — a fully static site. Deploy `dist/`
anywhere that serves static files over HTTPS (Vercel, Netlify, Cloudflare
Pages, S3+CloudFront, GitHub Pages, your own Nginx). HTTPS is required for
service workers and Geolocation to work outside `localhost`.

## Project structure

```
├── index.html            # entry HTML (manifest + icon links)
├── vite.config.js         # Vite + vite-plugin-pwa config (manifest, service worker)
├── public/
│   ├── pwa-192.png         # home-screen icon
│   ├── pwa-512.png         # home-screen icon (large)
│   ├── pwa-maskable-512.png# Android adaptive-icon safe zone
│   ├── apple-touch-icon.png
│   └── favicon.png
└── src/
    ├── main.jsx           # mounts React, registers the service worker
    ├── index.css          # fonts, resets, safe-area handling
    └── App.jsx            # Admin view, Salesman view, install/offline logic
```

## Wiring it to the real backend later

The architecture doc's API surface (`/auth/login`, `/salesman/leads`,
`/admin/salesmen/:id/location/live`, `/realtime/admin` WebSocket, etc.) maps
directly onto this UI:

- Replace the `SEED_SALESMEN` / `SEED_LEADS` state with data fetched from
  `/admin/*` and `/salesman/*` on load.
- Replace the `setInterval` live-movement simulation with the `/realtime/admin`
  WebSocket stream.
- In `AddLeadModal`'s `handleSubmit`, `POST` to `/salesman/leads` with the
  captured GPS fields and a `client_uuid` — the app already generates one
  (`uuid()`) and already models the `queued → synced` offline state, so the
  UI doesn't need to change, just where the data goes.
- For a native background-GPS experience (tracking while the phone is locked),
  a PWA is not enough on Android/iOS — that still needs the React Native/Expo
  app described in the architecture doc. This PWA is the right fit for
  foreground lead capture and the admin dashboard.

## Icon / brand

Icons were generated from the same "field ledger" palette as the UI (ink navy
`#1C2430`, route blue `#33507A`, paper `#FBFAF6`) so the home-screen icon
matches the in-app mark.
