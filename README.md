# Belgium Street Autocomplete API

Self-hosted address autocomplete API covering all of Belgium (Flanders, Wallonia, Brussels). Built on the official [BeSt Address](https://opendata.bosa.be) dataset (~10M addresses) published by SPF BOSA.

## Stack

| Component     | Choice                                              |
| ------------- | --------------------------------------------------- |
| Search engine | [Typesense](https://typesense.org)                  |
| Data source   | [BeSt Address](https://opendata.bosa.be) (SPF BOSA) |
| API           | Node.js / Fastify / TypeScript                      |
| Validation    | Zod                                                 |
| Logging       | Pino                                                |

## Architecture

```
Client (browser)
  │  GET https://yoursite.com/address?q=...
  │  X-Api-Key: <secret>
  ▼
Fastify proxy (port 3000)     ← only public endpoint
  │  API key check, rate limiting, validation
  ▼
Typesense (port 8108)         ← never exposed to the internet
  │
  ▼
"adresses" collection — BeSt Address data
```

## Environment variables

Copy `.env.example` to `.env` and fill in the values.

| Variable            | Required | Default     | Description                                                                                         |
| ------------------- | -------- | ----------- | --------------------------------------------------------------------------------------------------- |
| `TYPESENSE_API_KEY` | yes      | —           | Secret key for Typesense. Use a strong random string.                                               |
| `API_KEYS`          | no       | —           | Comma-separated list of valid API keys clients must send in `X-Api-Key`. Auth disabled if unset.    |
| `TYPESENSE_HOST`    | no       | `localhost` | Typesense hostname. Set to `typesense` when running via Docker Compose.                             |
| `ALLOWED_ORIGINS`   | yes      | —           | Comma-separated list of allowed CORS origins, e.g. `https://yoursite.com,https://app.yoursite.com`. |
| `PORT`              | no       | `3000`      | Port the API listens on.                                                                            |
| `LOG_LEVEL`         | no       | `info`      | Pino log level (`trace`, `debug`, `info`, `warn`, `error`).                                         |
| `BEST_DIR`          | no       | `/tmp/best` | Directory containing the extracted BeSt Address zip files used during import.                       |

## Development

**Prerequisites:** Node.js ≥ 22, Docker

```bash
# Install dependencies
npm install

# Start Typesense
docker compose up typesense -d

# Run the initial data import (downloads ~500 MB — see note below)
bash scripts/update.sh

# Start the API in watch mode
npm run dev
```

The API will be available at `http://localhost:3000`.

### Test UI

A minimal test interface is available in `test-ui/index.html`. Open it directly in your browser while the API is running:

```bash
open test-ui/index.html
```

It lets you set the `X-Api-Key`, adjust the result limit, and search addresses with live results showing street name variants (FR / NL / DE) and a region badge.

## Running with Docker

```bash
# Copy and fill in environment variables
cp .env.example .env

# Build and start all services (Typesense + API)
docker compose up -d --build

# Run the initial data import
docker compose run --rm -v /tmp/best:/tmp/best api node dist/scripts/import.js
```

> **Import time & disk usage**
>
> The full import processes ~5 million addresses across Brussels, Flanders, and Wallonia. Expect it to take **30–60 minutes** depending on your machine. Flanders alone accounts for roughly 3–4 million records and is the bottleneck.
>
> Once the import is complete, Typesense will use approximately **3–5 GB of disk space** in the `./data` volume. Make sure you have enough room before starting.
>
> Grab a coffee. Preferably a Belgian one.

To set up the weekly data refresh, add this cron job on the host:

```
0 3 * * 0 cd /path/to/project && NOTIFY_EMAIL=you@example.com bash scripts/update.sh >> /var/log/best-update.log 2>&1
```

`scripts/update.sh` downloads the latest BeSt zip, extracts it, runs the import, and sends an email notification on success or failure. The import uses a temporary collection and only switches the alias once the full import completes — the API stays available throughout.

Set `NOTIFY_EMAIL` to receive notifications. If unset, the script runs silently with no email.

## API

### `GET /address?q=<query>`

Returns up to 8 matching addresses (configurable via `limit`).

**Query parameters:**

| Parameter | Required | Default | Description                     |
| --------- | -------- | ------- | ------------------------------- |
| `q`       | yes      | —       | Search query (min 3 characters) |
| `limit`   | no       | `8`     | Number of results (1–20)        |

**Authentication:**

All requests must include the `X-Api-Key` header:

```
X-Api-Key: your-api-key
```

**Example:**

```
GET /address?q=Rue de la Loi 16
X-Api-Key: your-api-key
```

```json
[
  {
    "label": "Rue de la Loi 16, 1000 Bruxelles",
    "street_fr": "Rue de la Loi",
    "street_nl": "Wetstraat",
    "street_de": "",
    "house_number": "16",
    "postal_code": "1000",
    "municipality_fr": "Bruxelles",
    "municipality_nl": "Brussel",
    "municipality_de": "",
    "region": "Bruxelles",
    "lat": 50.8465,
    "lng": 4.365
  }
]
```

**Error responses:**

| Status | Description                                 |
| ------ | ------------------------------------------- |
| `400`  | Missing or invalid `q` parameter            |
| `401`  | Missing or invalid `X-Api-Key` header       |
| `429`  | Rate limit exceeded (30 requests/minute/IP) |
| `500`  | Typesense search error                      |

---

---

Built with the help of [Claude](https://claude.ai) by Anthropic.

> Fair warning: this project was largely written by an AI that has never actually lived in Belgium, doesn't know what a "frituur" is, and has never once been stuck behind a tram in Ghent. Philippe provided the vision, the coffee, and the occasional "non, pas comme ça" — Claude provided the code, the enthusiasm, and a worrying number of Lambert 72 coordinate projections.
>
> Found a bug? Claude will be delighted to help you fix it. It genuinely enjoys this stuff, possibly more than is healthy for a language model.
