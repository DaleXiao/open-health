# open-health

A private family health tracker built on Cloudflare Workers: daily weight and
exercise logs, weekly vitals (blood pressure, heart rate, height), GitHub-style
activity heatmaps, and LLM-drafted weekly meal menus with generated images —
all served from a single Hono + JSX worker with a D1 database.

## Live Demo

https://health.openclawd.co

## Features

- **Daily log** — weight + exercise per day, with validation and a combined
  timeline view.
- **Vitals event stream** — every blood-pressure / heart-rate / height
  submission is stored as an append-only event, charted on a real-time axis.
- **Trends & heatmaps** — weight trend with 1M/3M/6M/1Y ranges, BMI stats with
  ideal-range hints, and 26-week GitHub-style heatmaps for weight logging and
  exercise families.
- **Weekly menu** — 7 days × 4 meals (breakfast / lunch / dinner / snack),
  drafted by an LLM into a candidate pool, each slot with a generated image.
  Shuffle rotates to the next pool candidate; pools are refilled
  asynchronously (no live LLM calls at request time).
- **Async prefill pipeline** — a nightly guard kicks off one bounded LLM
  window per day; a `prefill_queue` table + every-10-minutes cron drain
  continuation work in slices, so LLM spend is strictly bounded by user count.
- **Admin** — user management, pool-integrity stats (aggregate-only by
  contract), request/error log views, and ops escape hatches for stuck jobs.
- **Read-only widget API** — `GET /api/me` with Bearer-token auth for personal
  dashboard widgets (e.g. iOS Scriptable).
- **Mobile-first UI** — warm-paper editorial theme, light/dark toggle,
  SSR-rendered JSX (no client-side framework).

## Architecture

- **Cloudflare Worker** — single deployable: serves the app, the API, and the
  static assets in `public/`.
- **Hono + JSX** — server-side rendered routes and views (`src/index.tsx`,
  `src/views/`), no client hydration.
- **D1 (SQLite)** — all persistence (`migrations/`): users, logs, vitals
  events, menu jobs/pool, prefill queue, request log. Role-aware DB guard
  blocks admin access to health data tables at the SQL level.
- **LLM gateway** — meal text and images are generated through an
  OpenAI-compatible gateway URL (`LLM_GATEWAY_URL`), optionally via a
  Worker-to-Worker service binding (`API_LLM`). Image bytes are fetched,
  compressed to 200×200 webp, and stored as blobs in D1.
- **Cron triggers** — `0 17 * * *` (nightly prefill guard) and `*/10 * * * *`
  (queue drain). A static guard script forbids every-minute triggers.

## Local Development

```bash
npm ci
npm run dev            # wrangler dev (local D1 + no service binding)
```

Create a local database and apply migrations:

```bash
npm run db:migrate:local
```

`wrangler dev` runs without the `API_LLM` service binding; the code
automatically falls back to `fetch(LLM_GATEWAY_URL)`, so a local
`.dev.vars` with `LLM_SERVICE_TOKEN` is enough to exercise the LLM paths
against any compatible gateway.

## Self-hosting

1. **Create the D1 database** and put its id in `wrangler.toml`:

   ```bash
   wrangler d1 create health_db
   # database_id = "REPLACE_WITH_YOUR_D1_DATABASE_ID"
   ```

2. **Apply migrations** to the remote database:

   ```bash
   npm run db:migrate:remote
   ```

3. **Set secrets** with `wrangler secret put`:

   | Secret | Purpose |
   | --- | --- |
   | `SESSION_SECRET` | 32+ byte random, HMAC-signs session cookies |
   | `DASHSCOPE_API_KEY` | model-provider API key for menu LLM / image generation |
   | `LLM_SERVICE_TOKEN` | Bearer token sent to the LLM gateway |
   | `ADMIN_BOOTSTRAP_USERNAME` | initial admin, used only while the users table is empty |
   | `ADMIN_BOOTSTRAP_PASSWORD` | initial admin password |
   | `API_TOKEN` / `API_USER_ID` | optional — Bearer auth for the read-only `GET /api/me` widget endpoint |

4. **Point `LLM_GATEWAY_URL` at any OpenAI-compatible gateway.** Request
   shapes are defined in `src/lib/menu-gen.ts`:

   - Chat: `POST ${LLM_GATEWAY_URL}/v1/chat/completions` with
     `Authorization: Bearer ${LLM_SERVICE_TOKEN}`, an `x-llm-usecase:
     menu-chat` header, and a JSON body (`model`, `messages`,
     `response_format: { type: 'json_object' }`). The response is read from
     `choices[0].message.content`.
   - Image: `POST ${LLM_GATEWAY_URL}/v1/images/generations` with the same
     auth header, `x-llm-usecase: menu-image`, and a body of
     `{ model, input: { messages: [...] }, parameters: { watermark: false } }`.
     The image reference is read from `output.choices[0].message.content[0].image`
     (an http(s) URL or an inline `data:` URL — both are handled).

5. **Replace the domain / routes**: uncomment the `[[routes]]` block in
   `wrangler.toml` and set your own domain (or enable `workers_dev`). If your
   gateway worker lives in the same Cloudflare account, uncomment the
   `[[services]]` binding block and set your own worker name.

6. **Configure vars** in `wrangler.toml` (`[vars]`):

   - `LLM_MODEL` — chat model used for menu generation (configurable; any
     model your gateway serves).
   - `IMAGE_MODEL` — image-generation model for meal pictures.
   - `DEFAULT_TZ` — IANA timezone that drives the nightly 03:00 prefill
     window and week boundaries (default `Australia/Melbourne`).
   - `LLM_TIMEOUT_MS` — LLM request timeout as a string (clamped to
     10s–600s; default 90s).

7. **Deploy**:

   ```bash
   npm run deploy
   ```

## Tests

```bash
npm test
```

Runs two static guard scripts (no every-minute cron triggers; live-LLM
endpoint literals confined to the private menu-gen helpers) plus the Node
test suite (`node --test`) covering auth, DB guards, menu-pool invariants,
the prefill pipeline, gateway request shapes, view/CSS contracts, and
security headers. Type checking:

```bash
./node_modules/.bin/tsc --noEmit
```

## License

MIT — see [LICENSE](LICENSE).
