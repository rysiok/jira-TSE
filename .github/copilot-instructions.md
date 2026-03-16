# Copilot Instructions — jira-TSE

## Project overview
Single-file Node.js CLI tool that exports Jira Time Tracker Flexible Report data via REST API.
**Zero dependencies** — uses only Node.js built-in modules (`https`, `fs`, `path`).

## Architecture
- `export-report.js` — the entire application (CLI parsing, HTTP client, Jira API calls, HTML/XLS generation)
- Calls Jira REST API v2 (`/rest/api/2/search`, `/rest/api/2/issue/{key}/worklog`) with Bearer PAT auth
- Generates HTML-based `.xls` files with a per-user summary table (hours in Polish locale decimals)
- Supports multiple comma-separated users from the report URL

## Key conventions
- **No dependencies**: never add npm packages or `package.json`. All code must use Node.js built-ins only.
- **Single file**: keep everything in `export-report.js`. Do not split into modules.
- **Auth**: PAT (Personal Access Token) only, via `--token` flag or `JIRA_PAT` env var.
- **HTML escaping**: always use `escapeHtml()` for any user-supplied or API-returned data rendered in output.

## Running
```bash
node export-report.js --url "<jira-report-url>" --token <pat> -o output.xls
node export-report.js --help
```

## Testing
No test framework. Verify manually:
```bash
node export-report.js --help          # should print usage and exit 0
node export-report.js --url "..." --token <pat> -o test.xls  # should produce valid .xls
```
