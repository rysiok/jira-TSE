#!/usr/bin/env node
// ==========================================================================
// Jira Time Tracker Flexible Report – standalone export script
// Pure Node.js, zero dependencies.
//
// Usage:
//   node export-report.js --url "<report-url>" -o output.xls
//
// Authentication:
//   --token <pat>  or  JIRA_PAT=<personal-access-token>  (Bearer token)
// ==========================================================================

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ---- CLI -------------------------------------------------------------------

function printHelp() {
  console.log(`
Jira Time Tracker Flexible Report – export script (zero dependencies)

Usage:
  node export-report.js --url "<report-url>" -o <output-file>

Required:
  --url <url>    Full report URL (copy from browser address bar)
  -o <file>      Output file path  (e.g. report.xls)

Authentication:
  --token <pat>      Personal Access Token (or set JIRA_PAT env var)

Examples:
  node export-report.js --url "https://jira.example.com/plugins/servlet/timereports?reportKey=jira-timesheet-plugin:timereportstt#!/?filterOrProjectId=filter_43643&startDate=2026-02-01&endDate=2026-02-28&groupByField=workeduser&sum=month&user=John.Doe&view=month&export=html" --token your-token -o feb-report.xls
`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--url':  opts.url = args[++i]; break;
      case '-o':     opts.output = args[++i]; break;
      case '--token': opts.token = args[++i]; break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
    }
  }
  if (!opts.url || !opts.output) {
    printHelp();
    process.exit(1);
  }
  return opts;
}

// ---- URL parsing -----------------------------------------------------------

function parseReportUrl(rawUrl) {
  // The URL has a hash-bang (#!) section with query parameters.
  // Example: https://host/plugins/servlet/timereports?reportKey=...#!/?filterOrProjectId=filter_43643&startDate=...
  const hashIdx = rawUrl.indexOf('#!/');
  if (hashIdx < 0) throw new Error('URL does not contain #!/ hash-bang section');

  const baseUrl = rawUrl.substring(0, hashIdx).split('?')[0];
  const origin = new URL(baseUrl).origin;

  const hashQuery = rawUrl.substring(hashIdx + 3); // after "#!/"
  const qIdx = hashQuery.indexOf('?');
  const paramStr = qIdx >= 0 ? hashQuery.substring(qIdx + 1) : hashQuery;
  const params = new URLSearchParams(paramStr);

  const filterOrProjectId = params.get('filterOrProjectId') || '';
  const filterId = filterOrProjectId.replace(/^filter_/, '');

  return {
    origin,
    filterId,
    startDate: params.get('startDate'),
    endDate: params.get('endDate'),
    users: params.get('user') ? params.get('user').split(',').map(u => u.trim()).filter(Boolean) : [],
    groupByField: params.get('groupByField') || 'workeduser',
    sum: params.get('sum') || 'month',
    view: params.get('view') || 'month',
    exportType: params.get('export') || 'html',
  };
}

// ---- HTTP helper -----------------------------------------------------------

function buildAuthHeaders() {
  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  };

  const pat = globalThis.__cliToken || process.env.JIRA_PAT;
  if (!pat) {
    throw new Error('No PAT configured. Use --token <pat> or set JIRA_PAT environment variable.');
  }
  headers['Authorization'] = `Bearer ${pat}`;
  return headers;
}

function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const location = res.headers.location;
        if (location) {
          const redirectUrl = location.startsWith('http') ? location : new URL(location, url).href;
          return httpGet(redirectUrl, headers).then(resolve, reject);
        }
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        if (res.statusCode === 401) {
          reject(new Error('Authentication failed (401). Check your --token / JIRA_PAT value.'));
          return;
        }
        if (res.statusCode === 403) {
          reject(new Error('Forbidden (403). Your token lacks permission for this resource.'));
          return;
        }
        if (res.statusCode >= 400) {
          let msg = `HTTP ${res.statusCode}`;
          try {
            const parsed = JSON.parse(body);
            const errs = parsed.errorMessages || [];
            if (errs.length) msg += ': ' + errs.join('; ');
          } catch (_) {
            msg += ': ' + body.substring(0, 500);
          }
          if (res.statusCode === 400 && body.includes('filter')) {
            msg += '\n  Hint: The saved filter may not be shared with your PAT user. '
              + 'In Jira, open the filter and share it with your account.';
          }
          reject(new Error(msg));
          return;
        }
        resolve(body);
      });
    });
    req.on('error', reject);
  });
}

async function jiraGet(origin, apiPath, headers) {
  const url = `${origin}${apiPath}`;
  const body = await httpGet(url, headers);
  return JSON.parse(body);
}

// ---- Jira data fetching ----------------------------------------------------

async function searchIssues(origin, headers, filterId, startDate, endDate, users) {
  // Replicate the same JQL the plugin builds:
  //   filter=<id> and worklogDate >= "<day-before-start>" and worklogDate < "<day-after-end>"
  //   and (worklogAuthor in ("user1","user2"))
  const dayBefore = shiftDate(startDate, -1);
  const dayAfter = shiftDate(endDate, +1);

  let jql = `filter=${filterId} and worklogDate >= "${dayBefore}" and worklogDate < "${dayAfter}"`;
  if (users.length > 0) {
    const quoted = users.map(u => `"${u}"`).join(',');
    jql += ` and (worklogAuthor in (${quoted}))`;
  }

  const fields = 'project,issuetype,summary,priority,status,worklog';
  const allIssues = [];
  let startAt = 0;

  // Paginate through all results
  while (true) {
    const apiPath = `/rest/api/2/search?fields=${encodeURIComponent(fields)}&maxResults=1000&jql=${encodeURIComponent(jql)}&startAt=${startAt}`;
    const data = await jiraGet(origin, apiPath, headers);
    allIssues.push(...data.issues);
    const pct = Math.round(allIssues.length / data.total * 100);
    process.stdout.write(`\rFetching issues... ${pct}%`);
    if (allIssues.length >= data.total) break;
    startAt = allIssues.length;
  }
  process.stdout.write('\n');
  return allIssues;
}

async function fetchFullWorklogs(origin, headers, issueKey, startDate) {
  // For issues with more worklogs than the inline limit (20),
  // fetch the full worklog list via the dedicated endpoint.
  // Paginates if total exceeds 1000.
  const startedAfter = Math.floor(new Date(startDate).getTime() / 1000) - 86400;
  const allWorklogs = [];
  let startAt = 0;

  while (true) {
    const apiPath = `/rest/api/2/issue/${encodeURIComponent(issueKey)}/worklog?maxResults=1000&startAt=${startAt}&startedAfter=${startedAfter}`;
    const data = await jiraGet(origin, apiPath, headers);
    const worklogs = data.worklogs || [];
    allWorklogs.push(...worklogs);
    if (allWorklogs.length >= data.total) break;
    startAt = allWorklogs.length;
  }
  return allWorklogs;
}

// ---- Data processing -------------------------------------------------------

function shiftDate(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function getMonthKey(dateStr) {
  // "2026-02-15T..." -> "2026-02"
  return dateStr.substring(0, 7);
}

function getMonthLabel(monthKey) {
  const [y, m] = monthKey.split('-');
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${names[parseInt(m, 10) - 1]} ${y}`;
}

function formatHours(seconds) {
  const h = seconds / 3600;
  return h.toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function processWorklogs(issues, startDate, endDate, targetUsers) {
  const start = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T23:59:59Z');
  const userSet = targetUsers.length > 0 ? new Set(targetUsers) : null;

  // Collect per-issue, per-month data grouped by user
  // Structure: { user: { issueKey: { summary, project, months: { monthKey: seconds }, total } } }
  const grouped = {};
  const allMonths = new Set();

  for (const issue of issues) {
    const worklogs = issue._worklogs || (issue.fields.worklog && issue.fields.worklog.worklogs) || [];
    for (const wl of worklogs) {
      const author = wl.author && wl.author.name;
      if (userSet && !userSet.has(author)) continue;

      const started = new Date(wl.started);
      if (started < start || started > end) continue;

      const monthKey = getMonthKey(wl.started);
      allMonths.add(monthKey);

      const displayName = wl.author.displayName || author;
      if (!grouped[displayName]) grouped[displayName] = {};
      if (!grouped[displayName][issue.key]) {
        grouped[displayName][issue.key] = {
          summary: issue.fields.summary,
          project: issue.fields.project && issue.fields.project.key,
          months: {},
          total: 0,
        };
      }
      const entry = grouped[displayName][issue.key];
      entry.months[monthKey] = (entry.months[monthKey] || 0) + wl.timeSpentSeconds;
      entry.total += wl.timeSpentSeconds;
    }
  }

  const months = Array.from(allMonths).sort();
  return { grouped, months };
}

// ---- HTML/XLS generation ---------------------------------------------------

function generateHtml(reportParams, grouped, months) {
  const { startDate, endDate, users, filterId } = reportParams;
  const monthHeaders = months.map(m =>
    `<th style="padding:6px 12px;text-align:right">${escapeHtml(getMonthLabel(m))}</th>`
  ).join('');

  let rows = '';

  for (const [displayName, issues] of Object.entries(grouped)) {
    const userMonths = {};

    for (const [, data] of Object.entries(issues)) {
      for (const m of months) {
        const sec = data.months[m] || 0;
        userMonths[m] = (userMonths[m] || 0) + sec;
      }
    }

    const monthCells = months.map(m =>
      `<td style="text-align:right;padding:6px 12px">${(userMonths[m] || 0) > 0 ? escapeHtml(formatHours(userMonths[m])) : ''}</td>`
    ).join('');

    rows += `      <tr>
        <td style="padding:6px 12px">${escapeHtml(displayName)}</td>
        ${monthCells}
      </tr>\n`;
  }

  const table = `
    <table border="1" cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:10pt">
      <tr style="background:#4472C4;color:#fff">
        <th style="padding:6px 12px;text-align:left"></th>
        ${monthHeaders}
      </tr>
${rows}
    </table>`;

  return table;
}

function wrapAsExcelHtml(tableHtml) {
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
<meta http-equiv="content-type" content="application/vnd.ms-excel; charset=utf-8">
<head>
<!--[if gte mso 9]>
<xml>
<x:ExcelWorkbook>
<x:ExcelWorksheets>
<x:ExcelWorksheet>
<x:Name>Timesheet</x:Name>
<x:WorksheetOptions>
<x:DisplayGridlines/>
</x:WorksheetOptions>
</x:ExcelWorksheet>
</x:ExcelWorksheets>
</x:ExcelWorkbook>
</xml>
<![endif]-->
</head>
<body>
${tableHtml}
</body>
</html>
`;
}

// ---- Main ------------------------------------------------------------------

async function main() {
  const startTime = process.hrtime.bigint();
  const { url, output, token } = parseArgs();
  if (token) globalThis.__cliToken = token;
  const params = parseReportUrl(url);
  const headers = buildAuthHeaders();

  console.log(`Jira       : ${params.origin}`);
  console.log(`Filter     : ${params.filterId}`);
  console.log(`Date range : ${params.startDate} – ${params.endDate}`);
  console.log(`Users      : ${params.users.length ? params.users.join(', ') : '(all)'}`);
  console.log(`Output     : ${output}`);
  console.log();

  // 1. Search for issues with worklogs in the date range
  const issues = await searchIssues(
    params.origin, headers,
    params.filterId, params.startDate, params.endDate, params.users
  );
  console.log(`Found ${issues.length} issues`);

  // 2. For issues where inline worklogs are truncated, fetch the full set
  const truncated = issues.filter(i => i.fields.worklog && i.fields.worklog.total > i.fields.worklog.maxResults);
  for (let idx = 0; idx < truncated.length; idx++) {
    const issue = truncated[idx];
    const pct = Math.round((idx + 1) / truncated.length * 100);
    process.stdout.write(`\rFetching full worklogs... ${pct}%`);
    issue._worklogs = await fetchFullWorklogs(
      params.origin, headers, issue.key, params.startDate
    );
  }
  if (truncated.length) process.stdout.write('\n');

  // 3. Process worklogs
  console.log('Processing worklogs...');
  const { grouped, months } = processWorklogs(issues, params.startDate, params.endDate, params.users);

  // 4. Generate export
  console.log('Generating report...');
  const tableHtml = generateHtml(params, grouped, months);
  const fileContent = wrapAsExcelHtml(tableHtml);

  // 5. Write to file
  const outputDir = path.dirname(path.resolve(output));
  if (outputDir && !fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  fs.writeFileSync(output, fileContent, 'utf-8');
  const elapsed = Number(process.hrtime.bigint() - startTime) / 1e9;
  console.log(`\nDone! Report saved to: ${path.resolve(output)}`);
  console.log(`Generated in ${elapsed.toFixed(2)}s`);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
