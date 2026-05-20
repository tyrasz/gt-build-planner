# GT Build Planner

Local deterministic build planner for Galactic Tycoons. The app reads live company data from the Public API, ranks high-impact build targets, and prepares reviewable wishlist/base-plan drafts. It never stores API keys and does not write to Galactic Tycoons unless a request includes explicit confirmation.

## Run Locally

```bash
npm install
npm run dev
```

Open http://127.0.0.1:5173.

## Security Model

- Galactic Tycoons API keys are kept only in backend process memory.
- The browser receives an HTTP-only session cookie.
- Closing the backend process clears sessions and cached company data.
- Wishlist and base-plan endpoints return manual-only output unless `confirmed: true`.
- Base-plan write support uses the documented planner endpoint when available and falls back to a manual draft if the endpoint or key rejects the request.

## Tests

```bash
npm run lint
npm test
npm run test:e2e
```

## GitHub Pages

The hosted Pages build is static and does not use the Fastify backend. In that mode, the browser keeps the Galactic Tycoons API key only in tab memory and sends requests directly to `https://api.g2.galactictycoons.com`.

```bash
npm run build:pages
```
