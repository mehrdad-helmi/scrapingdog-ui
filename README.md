# LinkedIn API Caller

CLI app with web UI that calls the ScrapingDog profile API for each LinkedIn profile ID from a todo list, with a 4-concurrent limit and 2–4s random delay between batches.

## Setup

```bash
npm install
```

## Input

- Put LinkedIn profile IDs (one per line) in **`todo-list-ids.txt`** (or `todo_list_ids.txt`).

## Run

```bash
npm start
```

Then open **http://localhost:3847** and click **Start** to begin. Use **Stop** to pause; remaining IDs are written to `remaining-ids.txt`. Click **Start** again to resume from `remaining-ids.txt` if it exists.

## Output

- **`result-json/<id>.json`** – one JSON file per successful profile
- **`done-ids.txt`** – IDs that succeeded
- **`failed-ids.txt`** – IDs that failed (with API errors)
- **`remaining-ids.txt`** – created when the run is stopped before finishing

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
