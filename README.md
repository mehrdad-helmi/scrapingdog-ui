# LinkedIn API Caller

CLI app with web UI that calls the ScrapingDog profile API

## Setup

```bash
bun install
```

## Input

- Put LinkedIn profile IDs (one per line) in **`input-ids.txt`**
- Create a .env file based on `.env.example`

## Run **development**

```bash
 bun start:dev
```

## Run

```bash
bun start
```

Then open **http://localhost:3847** and click **Start** to begin. Use **Stop** to pause; remaining IDs are written to `remaining-ids.txt`. Click **Start** again to resume from `remaining-ids.txt` if it exists.

## Output

- **`result-json/<id>.json`** – one JSON file per successful profile
- **`input-ids.txt`** – Input file with LinkedIn profile IDs (one per line)
- **`done-ids.txt`** – IDs that succeeded **DO NOT EDIT MANUALLY!**
- **`failed-ids.txt`** – IDs that failed (with API errors) **DO NOT EDIT MANUALLY!**
- **`failed-details.json`** – Failed ids and their error details **DO NOT EDIT MANUALLY!**
- **`remaining-ids.txt`** – Working source for scrapping **DO NOT EDIT MANUALLY!**

## API status codes

| Code | Meaning |
|------|--------|
| 200 | Successful request |
| 410 | Request timeout |
| 404 | URL is wrong |
| 202 | Request accepted, scraping in progress |
| 403 | Request limit reached |
| 429 | Concurrent connection limit reached |
| 401 | API key is wrong |
| 400 | Request failed |
