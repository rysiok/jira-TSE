# Copilot Instructions — jira-TSE

## Project overview
Single-file Node.js tool that exports Jira Time Tracker Flexible Report data via REST API.
Dual-mode: CLI tool (export to file) and HTTP REST API server (returns JSON).
**Zero dependencies** — uses only Node.js built-in modules (`https`, `http`, `fs`, `path`, `crypto`).

## Architecture
- `export-report.js` — the entire application (CLI, HTTP server, Jira API client, JSON report generation)
- `Dockerfile` — minimal Alpine container running the server
- `generateReport({ url, token, quiet })` — core async function shared by CLI and server; returns `{ "username": { hours, email } }` JSON object
- `main()` — thin CLI wrapper: parses args, calls `generateReport()`, writes file
- `startServer(opts)` — HTTP server with async polling: `POST /report` (returns jobId), `GET /report/<id>` (poll status), `GET /health`
- Calls Jira REST API v2 (`/rest/api/2/search`, `/rest/api/2/issue/{key}/worklog`) with Bearer PAT auth
- Generates JSON output keyed by Jira username with `{ hours, email }` per user
- Supports multiple comma-separated users from the report URL
- Supports Jira instances at a subpath (e.g. `https://host/jira/plugins/servlet/...`)

## Key conventions
- **No dependencies**: never add npm packages or `package.json`. All code must use Node.js built-ins only.
- **Single file**: keep everything in `export-report.js`. Do not split into modules.
- **Auth**: PAT (Personal Access Token) only, via `--token` flag, `JIRA_PAT` env var, or `Authorization: Bearer <PAT>` header (server mode).
- **HTML escaping**: always use `escapeHtml()` for any user-supplied or API-returned data rendered in output.
- **Security**: do not log sensitive info (e.g. tokens), and handle errors gracefully without exposing stack traces or internal details; do not commit any secrets. Validate `url` starts with `https://` in server mode to prevent SSRF.
- **Security**: never add .env file to repository. Do not commit any secrets. Add .env to .gitignore.
- **Pushing to GitHub**: commit all changes with clear messages, and push to the `main` branch. Do not create branches or pull requests. Do not delete or rewrite history. 
- **Testing**: write unit tests using Node.js built-in test runner (`node:test`) in `test.js`. Cover core logic and edge cases. Run tests with `node --test test.js` before pushing.
- **Documentation**: keep `README.md` and `copilot-instructions.md` up to date with usage instructions, examples, and testing steps. Do not remove or significantly alter existing documentation. Update documentation before pushing any changes that affect usage or behavior.

## Running
```bash
# CLI mode
node export-report.js --url "<jira-report-url>" --token <pat> -o output.json
node export-report.js --url "<jira-report-url>" --token <pat>  # prints JSON to stdout
node export-report.js --help

# Server mode
node export-report.js --server --port 3000

# Docker
docker build -t jira-tse .
docker run -p 3000:3000 jira-tse
```

## Testing
Unit tests use Node.js built-in test runner (`node:test`) — zero dependencies.
```bash
node --test test.js             # run all tests
```

Manual verification:
```bash
node export-report.js --help          # should print usage and exit 0
node export-report.js --url "..." --token <pat> -o test.json  # should produce valid .json
node export-report.js --server        # should start on port 3000
curl http://localhost:3000/health      # should return {"status":"ok"}
curl -X POST http://localhost:3000/report -H "Content-Type: application/json" -H "Authorization: Bearer <pat>" -d '{"url":"https://..."}'
# → {"jobId":"..."}
curl http://localhost:3000/report/<jobId>
# → {"jobId":"...","status":"pending|complete|error",...}
```
