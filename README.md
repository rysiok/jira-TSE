# jira-TSE — Jira Timesheet Export

Standalone Node.js CLI tool that exports **Jira Time Tracker Flexible Report** data via REST API. Zero dependencies — uses only Node.js built-in modules.

## Quick start

```bash
node export-report.js --url "<report-url>" --token <pat> -o output.xls
```

Copy the full report URL from your browser address bar (including the `#!/?...` hash parameters) and pass it directly.

## Authentication

The script uses a **Personal Access Token (PAT)** for authentication.

Generate one in Jira: **Profile → Personal Access Tokens → Create token**.

Provide it via:
- `--token <pat>` flag (recommended)
- `JIRA_PAT` environment variable

## Usage

```
node export-report.js --url "<report-url>" -o <output-file>

Required:
  --url <url>    Full report URL (copy from browser address bar)
  -o <file>      Output file path  (e.g. report.xls)

Authentication:
  --token <pat>  Personal Access Token (or set JIRA_PAT env var)

Other:
  --help, -h     Show help message
```

## Examples

```bash
# Export February 2026 timesheet for a specific user
node export-report.js \
  --url "https://jira.example.com/plugins/servlet/timereports?reportKey=jira-timesheet-plugin:timereportstt#!/?filterOrProjectId=filter_43643&startDate=2026-02-01&endDate=2026-02-28&groupByField=workeduser&sum=month&user=John.Doe&view=month&export=html" \
  --token my-pat-token \
  -o feb-2026.xls

# Multiple users (comma-separated in the URL)
node export-report.js \
  --url "https://jira.example.com/...#!/?...&user=John.Doe,Jane.Smith&..." \
  --token my-pat-token \
  -o team-report.xls

# All users (use allUsers=true instead of user=...)
node export-report.js \
  --url "https://jira.example.com/...#!/?...&allUsers=true&..." \
  --token my-pat-token \
  -o all-users-report.xls

# Using environment variable for the token
export JIRA_PAT=my-pat-token
node export-report.js --url "..." -o report.xls
```

On Windows (PowerShell):
```powershell
$env:JIRA_PAT="my-pat-token"
node export-report.js --url "..." -o report.xls
```

## How it works

1. Parses the report URL to extract filter ID, date range, users, and grouping parameters
2. Calls Jira REST API v2 (`/rest/api/2/search`) with the equivalent JQL query
3. Fetches full worklogs for issues where inline worklog data is truncated (handles pagination for >1000 entries); shows progress as percentage
4. Aggregates worklogs by user and month
5. Generates an HTML-based `.xls` file with a per-user summary table
6. Prints total generation time

## Output format

The generated `.xls` file is an HTML table wrapped in Excel-compatible markup. It opens in Excel, LibreOffice Calc, and Google Sheets.

- One row per user with per-month hour columns
- Hours formatted as Polish locale decimals (e.g. `118,00` / `110,37`)
- Supports single user, multiple users (comma-separated), or all users (`allUsers=true`)

## Requirements

- Node.js 14+ (no npm install needed)
