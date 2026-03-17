# jira-TSE — Jira Timesheet Export

Standalone Node.js tool that exports **Jira Time Tracker Flexible Report** data via REST API. Runs as a CLI tool or an HTTP REST API server. Zero dependencies — uses only Node.js built-in modules.

## Quick start

### CLI mode

```bash
node export-report.js --url "<report-url>" --token <pat> -o output.json
node export-report.js --url "<report-url>" --token <pat>   # prints JSON to stdout
```

Copy the full report URL from your browser address bar (including the `#!/?...` hash parameters) and pass it directly. Works with both root-level Jira instances (e.g. `https://jira.example.com/plugins/servlet/...`) and those deployed at a subpath (e.g. `https://jira.example.com/jira/plugins/servlet/...`).

### Server mode

```bash
node export-report.js --server --port 3000
```

Or with Docker:

```bash
docker build -t jira-tse .
docker run -p 3000:3000 jira-tse
```

## Authentication

The script uses a **Personal Access Token (PAT)** for authentication.

Generate one in Jira: **Profile → Personal Access Tokens → Create token**.

Provide it via:
- **CLI mode**: `--token <pat>` flag or `JIRA_PAT` environment variable
- **Server mode**: `Authorization: Bearer <pat>` header

## Usage

```
CLI mode:
  node export-report.js --url "<report-url>" [-o <output-file>]

  --url <url>    Full report URL (copy from browser address bar)
  -o <file>      Output file path (e.g. report.json); omit to print JSON to stdout
  --token <pat>  Personal Access Token (or set JIRA_PAT env var)

Server mode (REST API):
  node export-report.js --server [--port <port>]

  --server       Start HTTP server instead of CLI export
  --port <port>  Server port (default: 3000, or PORT env var)

Other:
  --help, -h     Show help message
```

## REST API

### `POST /report`

Generate a report and return it as JSON.

**Request:**
```bash
curl -X POST http://localhost:3000/report \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-personal-access-token" \
  -d '{"url": "https://jira.example.com/jira/plugins/servlet/timereports?reportKey=...#!/?filterOrProjectId=filter_43643&startDate=2026-02-01&endDate=2026-02-28&..."}'
```

**Response (200):**
```json
{
  "John Doe": 118.5,
  "Smith, Jane": 96.25
}
```

Returns a JSON object mapping Jira display names to total hours worked.

**Error responses:**
- `400` — missing/invalid fields, invalid URL, bad Jira request
- `401` — authentication failed (missing or invalid token)
- `403` — insufficient permissions
- `413` — request body too large (>1 MB)
- `500` — internal server error

### `GET /health`

Health check endpoint for Docker/orchestrator probes.

**Response (200):**
```json
{ "status": "ok" }
```

## Examples

### CLI

```bash
# Export February 2026 timesheet for a specific user
node export-report.js \
  --url "https://jira.example.com/plugins/servlet/timereports?reportKey=jira-timesheet-plugin:timereportstt#!/?filterOrProjectId=filter_43643&startDate=2026-02-01&endDate=2026-02-28&groupByField=workeduser&sum=month&user=John.Doe&view=month&export=html" \
  --token my-pat-token \
  -o feb-2026.json

# Multiple users (comma-separated in the URL)
node export-report.js \
  --url "https://jira.example.com/...#!/?...&user=John.Doe,Jane.Smith&..." \
  --token my-pat-token \
  -o team-report.json

# All users (use allUsers=true instead of user=...)
node export-report.js \
  --url "https://jira.example.com/...#!/?...&allUsers=true&..." \
  --token my-pat-token \
  -o all-users-report.json

# Using environment variable for the token
export JIRA_PAT=my-pat-token
node export-report.js --url "..." -o report.json
```

On Windows (PowerShell):
```powershell
$env:JIRA_PAT="my-pat-token"
node export-report.js --url "..." -o report.json
```

### Server

```bash
# Start the server
node export-report.js --server --port 8080

# Generate a report via curl
curl -X POST http://localhost:8080/report \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer my-pat-token" \
  -d '{"url": "https://jira.example.com/...#!/?..."}'

# Save report to file
curl -s -X POST http://localhost:8080/report \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer my-pat-token" \
  -d '{"url": "..."}' \
  | node -e "process.stdin.on('data',d=>{const r=JSON.parse(d);process.stdout.write(JSON.stringify(r.report,null,2))})" \
  > report.json
```

### Docker

```bash
docker build -t jira-tse .
docker run -p 3000:3000 jira-tse

# Custom port
docker run -p 8080:8080 -e PORT=8080 jira-tse
```

## How it works

1. Parses the report URL to extract Jira base URL (including any context path like `/jira`), filter ID, date range, users, and grouping parameters
2. Calls Jira REST API v2 (`/rest/api/2/search`) with the equivalent JQL query
3. Fetches full worklogs for issues where inline worklog data is truncated (handles pagination for >1000 entries); shows progress as percentage (CLI mode)
4. Aggregates worklogs by user
5. Generates a JSON report mapping display names to total hours
6. In CLI mode: writes JSON to disk and prints generation time
7. In server mode: returns JSON report in `{ "report": { ... } }` response

## Output format

The output is a JSON object with one entry per user:

```json
{
  "John Doe": 118.5,
  "Jane Smith": 96.25
}
```

- Keys use the original display name from the Jira API
- Values are total hours worked, rounded to two decimal places
- Supports single user, multiple users (comma-separated), or all users (`allUsers=true`)

## Requirements

- Node.js 18+ (no npm install needed)
- Docker (optional, for containerized deployment)

## Testing

Unit tests use Node.js built-in test runner (`node:test`) — zero dependencies:

```bash
node --test test.js
```

Covers: URL parsing, date utilities, HTML escaping, worklog aggregation, HTML/Excel generation, REST API validation (health, 404, input checks, SSRF), and end-to-end report generation with a mocked Jira server.
