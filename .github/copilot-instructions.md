# Copilot Instructions — jira-TSE

## Project overview
Single-file Node.js tool that exports Jira Time Tracker Flexible Report data via REST API.
Dual-mode: CLI tool (export to file) and HTTP REST API server (returns base64 JSON).
**Zero dependencies** — uses only Node.js built-in modules (`https`, `http`, `fs`, `path`).

## Architecture
- `export-report.js` — the entire application (CLI, HTTP server, Jira API client, HTML/XLS generation)
- `Dockerfile` — minimal Alpine container running the server
- `generateReport({ url, token, quiet })` — core async function shared by CLI and server
- `main()` — thin CLI wrapper: parses args, calls `generateReport()`, writes file
- `startServer(opts)` — HTTP server: `POST /report` and `GET /health`
- Calls Jira REST API v2 (`/rest/api/2/search`, `/rest/api/2/issue/{key}/worklog`) with Bearer PAT auth
- Generates HTML-based `.xls` files with a per-user summary table (hours in Polish locale decimals)
- Supports multiple comma-separated users from the report URL

## Key conventions
- **No dependencies**: never add npm packages or `package.json`. All code must use Node.js built-ins only.
- **Single file**: keep everything in `export-report.js`. Do not split into modules.
- **Auth**: PAT (Personal Access Token) only, via `--token` flag, `JIRA_PAT` env var, or `token` in request body.
- **HTML escaping**: always use `escapeHtml()` for any user-supplied or API-returned data rendered in output.
- **Security**: do not log sensitive info (e.g. tokens), and handle errors gracefully without exposing stack traces or internal details; do not commit any secrets. Validate `url` starts with `https://` in server mode to prevent SSRF.

## Running
```bash
# CLI mode
node export-report.js --url "<jira-report-url>" --token <pat> -o output.xls
node export-report.js --help

# Server mode
node export-report.js --server --port 3000

# Docker
docker build -t jira-tse .
docker run -p 3000:3000 jira-tse
```

## Testing
No test framework. Verify manually:
```bash
node export-report.js --help          # should print usage and exit 0
node export-report.js --url "..." --token <pat> -o test.xls  # should produce valid .xls
node export-report.js --server        # should start on port 3000
curl http://localhost:3000/health      # should return {"status":"ok"}
curl -X POST http://localhost:3000/report -H "Content-Type: application/json" -d '{"url":"...","token":"..."}'
```
