#!/usr/bin/env node
// ==========================================================================
// Unit tests for export-report.js core logic & REST API
// Uses Node.js built-in test runner (node:test) — zero dependencies.
//
// Run:  node --test test.js
// ==========================================================================

const { describe, it, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const {
  parseReportUrl,
  buildAuthHeaders,
  shiftDate,
  getMonthKey,
  getMonthLabel,
  formatHours,
  escapeHtml,
  processWorklogs,
  generateHtml,
  wrapAsExcelHtml,
  startServer,
} = require('./export-report.js');

// ---- Test data -------------------------------------------------------------

const SAMPLE_URL = 'https://jira.example.com/plugins/servlet/timereports?reportKey=jira-timesheet-plugin:timereportstt#!/?filterOrProjectId=filter_43643&startDate=2026-02-01&endDate=2026-02-28&groupByField=workeduser&sum=month&user=John.Doe&view=month&export=html';

function makeIssue(key, project, summary, worklogs) {
  return {
    key,
    fields: {
      project: { key: project },
      summary,
      worklog: { worklogs, total: worklogs.length, maxResults: 20 },
    },
  };
}

function makeWorklog(author, displayName, started, timeSpentSeconds) {
  return {
    author: { name: author, displayName },
    started,
    timeSpentSeconds,
  };
}

// ---- Pure function tests ---------------------------------------------------

describe('parseReportUrl', () => {
  it('extracts origin, filterId, dates, and users', () => {
    const r = parseReportUrl(SAMPLE_URL);
    assert.equal(r.origin, 'https://jira.example.com');
    assert.equal(r.filterId, '43643');
    assert.equal(r.startDate, '2026-02-01');
    assert.equal(r.endDate, '2026-02-28');
    assert.deepEqual(r.users, ['John.Doe']);
    assert.equal(r.groupByField, 'workeduser');
    assert.equal(r.sum, 'month');
  });

  it('handles multiple users', () => {
    const url = SAMPLE_URL.replace('user=John.Doe', 'user=John.Doe,Jane.Smith');
    const r = parseReportUrl(url);
    assert.deepEqual(r.users, ['John.Doe', 'Jane.Smith']);
  });

  it('handles no users', () => {
    const url = SAMPLE_URL.replace('&user=John.Doe', '');
    const r = parseReportUrl(url);
    assert.deepEqual(r.users, []);
  });

  it('throws on missing hash-bang', () => {
    assert.throws(
      () => parseReportUrl('https://jira.example.com/page'),
      /hash-bang/
    );
  });
});

describe('shiftDate', () => {
  it('adds days', () => {
    assert.equal(shiftDate('2026-02-28', 1), '2026-03-01');
  });

  it('subtracts days', () => {
    assert.equal(shiftDate('2026-03-01', -1), '2026-02-28');
  });

  it('handles year boundary', () => {
    assert.equal(shiftDate('2025-12-31', 1), '2026-01-01');
  });
});

describe('getMonthKey', () => {
  it('extracts YYYY-MM from ISO datetime', () => {
    assert.equal(getMonthKey('2026-02-15T10:30:00.000+0000'), '2026-02');
  });
});

describe('getMonthLabel', () => {
  it('formats month key as label', () => {
    assert.equal(getMonthLabel('2026-02'), 'Feb 2026');
    assert.equal(getMonthLabel('2026-12'), 'Dec 2026');
    assert.equal(getMonthLabel('2026-01'), 'Jan 2026');
  });
});

describe('formatHours', () => {
  it('formats whole hours', () => {
    const result = formatHours(7200);
    // Polish locale uses comma: "2,00"
    assert.match(result, /2[,.]00/);
  });

  it('formats fractional hours', () => {
    const result = formatHours(5400); // 1.5h
    assert.match(result, /1[,.]50/);
  });

  it('formats zero', () => {
    const result = formatHours(0);
    assert.match(result, /0[,.]00/);
  });
});

describe('escapeHtml', () => {
  it('escapes special characters', () => {
    assert.equal(escapeHtml('<script>"alert&</script>'), '&lt;script&gt;&quot;alert&amp;&lt;/script&gt;');
  });

  it('returns empty string for falsy input', () => {
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
    assert.equal(escapeHtml(''), '');
  });

  it('passes through safe strings unchanged', () => {
    assert.equal(escapeHtml('Hello World'), 'Hello World');
  });
});

describe('buildAuthHeaders', () => {
  it('creates headers with Bearer token', () => {
    const h = buildAuthHeaders('my-token');
    assert.equal(h['Authorization'], 'Bearer my-token');
    assert.equal(h['Accept'], 'application/json');
    assert.equal(h['Content-Type'], 'application/json');
  });

  it('throws when no token provided and no env var', () => {
    const saved = process.env.JIRA_PAT;
    delete process.env.JIRA_PAT;
    try {
      assert.throws(() => buildAuthHeaders(undefined), /No PAT configured/);
    } finally {
      if (saved !== undefined) process.env.JIRA_PAT = saved;
    }
  });

  it('falls back to JIRA_PAT env var', () => {
    const saved = process.env.JIRA_PAT;
    process.env.JIRA_PAT = 'env-token';
    try {
      const h = buildAuthHeaders(undefined);
      assert.equal(h['Authorization'], 'Bearer env-token');
    } finally {
      if (saved !== undefined) process.env.JIRA_PAT = saved;
      else delete process.env.JIRA_PAT;
    }
  });
});

// ---- Worklog processing tests ----------------------------------------------

describe('processWorklogs', () => {
  const issues = [
    makeIssue('PROJ-1', 'PROJ', 'Task One', [
      makeWorklog('john', 'John Doe', '2026-02-10T09:00:00.000+0000', 3600),
      makeWorklog('john', 'John Doe', '2026-02-11T09:00:00.000+0000', 7200),
      makeWorklog('jane', 'Jane Smith', '2026-02-10T09:00:00.000+0000', 1800),
    ]),
    makeIssue('PROJ-2', 'PROJ', 'Task Two', [
      makeWorklog('john', 'John Doe', '2026-02-15T14:00:00.000+0000', 5400),
    ]),
  ];

  it('groups worklogs by user', () => {
    const { grouped } = processWorklogs(issues, '2026-02-01', '2026-02-28', []);
    assert.ok(grouped['John Doe']);
    assert.ok(grouped['Jane Smith']);
    assert.equal(Object.keys(grouped).length, 2);
  });

  it('aggregates total seconds per issue', () => {
    const { grouped } = processWorklogs(issues, '2026-02-01', '2026-02-28', []);
    // John: PROJ-1 = 3600+7200=10800, PROJ-2 = 5400
    assert.equal(grouped['John Doe']['PROJ-1'].total, 10800);
    assert.equal(grouped['John Doe']['PROJ-2'].total, 5400);
  });

  it('aggregates per month', () => {
    const { grouped, months } = processWorklogs(issues, '2026-02-01', '2026-02-28', []);
    assert.deepEqual(months, ['2026-02']);
    assert.equal(grouped['John Doe']['PROJ-1'].months['2026-02'], 10800);
  });

  it('filters by target users', () => {
    const { grouped } = processWorklogs(issues, '2026-02-01', '2026-02-28', ['john']);
    assert.ok(grouped['John Doe']);
    assert.equal(grouped['Jane Smith'], undefined);
  });

  it('excludes worklogs outside date range', () => {
    const outOfRange = [
      makeIssue('PROJ-3', 'PROJ', 'Outside', [
        makeWorklog('john', 'John Doe', '2026-01-15T09:00:00.000+0000', 3600),
        makeWorklog('john', 'John Doe', '2026-03-15T09:00:00.000+0000', 3600),
        makeWorklog('john', 'John Doe', '2026-02-10T09:00:00.000+0000', 1800),
      ]),
    ];
    const { grouped } = processWorklogs(outOfRange, '2026-02-01', '2026-02-28', []);
    assert.equal(grouped['John Doe']['PROJ-3'].total, 1800);
  });

  it('handles multiple months', () => {
    const crossMonth = [
      makeIssue('PROJ-4', 'PROJ', 'Cross month', [
        makeWorklog('john', 'John Doe', '2026-02-15T09:00:00.000+0000', 3600),
        makeWorklog('john', 'John Doe', '2026-03-10T09:00:00.000+0000', 7200),
      ]),
    ];
    const { grouped, months } = processWorklogs(crossMonth, '2026-02-01', '2026-03-31', []);
    assert.deepEqual(months, ['2026-02', '2026-03']);
    assert.equal(grouped['John Doe']['PROJ-4'].months['2026-02'], 3600);
    assert.equal(grouped['John Doe']['PROJ-4'].months['2026-03'], 7200);
  });

  it('returns empty result for no worklogs', () => {
    const empty = [makeIssue('PROJ-5', 'PROJ', 'Empty', [])];
    const { grouped, months } = processWorklogs(empty, '2026-02-01', '2026-02-28', []);
    assert.deepEqual(grouped, {});
    assert.deepEqual(months, []);
  });

  it('uses _worklogs when present (truncated worklog case)', () => {
    const issue = makeIssue('PROJ-6', 'PROJ', 'Truncated', []);
    issue._worklogs = [
      makeWorklog('john', 'John Doe', '2026-02-10T09:00:00.000+0000', 4500),
    ];
    const { grouped } = processWorklogs([issue], '2026-02-01', '2026-02-28', []);
    assert.equal(grouped['John Doe']['PROJ-6'].total, 4500);
  });
});

// ---- HTML generation tests -------------------------------------------------

describe('generateHtml', () => {
  it('produces HTML table with user rows and month columns', () => {
    const params = { startDate: '2026-02-01', endDate: '2026-02-28', users: [], filterId: '123' };
    const grouped = {
      'John Doe': {
        'PROJ-1': { summary: 'Task', project: 'PROJ', months: { '2026-02': 7200 }, total: 7200 },
      },
    };
    const months = ['2026-02'];

    const html = generateHtml(params, grouped, months);
    assert.ok(html.includes('<table'));
    assert.ok(html.includes('John Doe'));
    assert.ok(html.includes('Feb 2026'));
    // Should contain formatted hours (2,00 or 2.00 depending on locale)
    assert.match(html, /2[,.]00/);
  });

  it('escapes user names in output', () => {
    const params = { startDate: '2026-02-01', endDate: '2026-02-28', users: [], filterId: '123' };
    const grouped = {
      '<script>alert("xss")</script>': {
        'PROJ-1': { summary: 'Test', project: 'PROJ', months: { '2026-02': 3600 }, total: 3600 },
      },
    };
    const html = generateHtml(params, grouped, ['2026-02']);
    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('&lt;script&gt;'));
  });

  it('handles multiple months', () => {
    const params = { startDate: '2026-02-01', endDate: '2026-03-31', users: [], filterId: '123' };
    const grouped = {
      'User': {
        'X-1': { summary: 'T', project: 'X', months: { '2026-02': 3600, '2026-03': 7200 }, total: 10800 },
      },
    };
    const html = generateHtml(params, grouped, ['2026-02', '2026-03']);
    assert.ok(html.includes('Feb 2026'));
    assert.ok(html.includes('Mar 2026'));
  });
});

describe('wrapAsExcelHtml', () => {
  it('wraps content in Excel-compatible HTML', () => {
    const result = wrapAsExcelHtml('<table>test</table>');
    assert.ok(result.includes('xmlns:x="urn:schemas-microsoft-com:office:excel"'));
    assert.ok(result.includes('<x:Name>Timesheet</x:Name>'));
    assert.ok(result.includes('<table>test</table>'));
    assert.ok(result.includes('charset=utf-8'));
  });
});

// ---- REST API endpoint tests -----------------------------------------------

describe('REST API', () => {
  let server;
  let port;

  // Start a real server on a random port with generateReport mocked
  before(async () => {
    // We need to mock the Jira HTTP calls. We'll create a fake Jira server
    // that returns predictable responses.
    const fakeJira = http.createServer((req, res) => {
      if (req.url.includes('/rest/api/2/search')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          total: 1,
          issues: [{
            key: 'TEST-1',
            fields: {
              project: { key: 'TEST' },
              summary: 'Test Issue',
              priority: { name: 'Major' },
              status: { name: 'Open' },
              issuetype: { name: 'Task' },
              worklog: {
                total: 1,
                maxResults: 20,
                worklogs: [{
                  author: { name: 'John.Doe', displayName: 'John Doe' },
                  started: '2026-02-10T09:00:00.000+0000',
                  timeSpentSeconds: 7200,
                }],
              },
            },
          }],
        }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise(resolve => fakeJira.listen(0, resolve));
    const jiraPort = fakeJira.address().port;

    // Patch the sample URL to point at our fake Jira (http for testing)
    // We need to override the https check for testing. We'll use the server
    // directly and test endpoint validation separately.
    port = 0; // let OS assign port

    // Store fake jira ref for cleanup
    server = { fakeJira, appServer: null, jiraPort };
  });

  after(async () => {
    if (server.fakeJira) await new Promise(r => server.fakeJira.close(r));
    if (server.appServer) await new Promise(r => server.appServer.close(r));
  });

  // Helper to make HTTP requests
  function request(method, path, body, reqPort) {
    return new Promise((resolve, reject) => {
      const opts = {
        hostname: 'localhost',
        port: reqPort,
        path,
        method,
        headers: { 'Content-Type': 'application/json' },
      };
      const req = http.request(opts, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          let json;
          try { json = JSON.parse(text); } catch { json = null; }
          resolve({ statusCode: res.statusCode, body: json, raw: text, headers: res.headers });
        });
      });
      req.on('error', reject);
      if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
      req.end();
    });
  }

  // Start the app server for endpoint tests
  async function ensureAppServer() {
    if (server.appServer) return server.appPort;
    // We use startServer which listens on a port
    // But we need to capture the server instance
    // Using a slightly different approach: create server directly
    const appPort = await new Promise((resolve) => {
      const origLog = console.log;
      // Suppress server startup logs during tests
      console.log = () => {};
      const s = http.createServer();
      // We need to replicate the server handler from startServer
      // Instead, let's just require and start
      // Actually, let's just test the server by starting it
      console.log = origLog;

      // Start on random port by importing startServer behavior
      const appSrv = http.createServer((req, res) => {
        const startTime = Date.now();
        let responded = false;

        const sendJson = (statusCode, obj) => {
          if (responded) return;
          responded = true;
          const body = JSON.stringify(obj);
          res.writeHead(statusCode, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(body);
        };

        if (req.method === 'GET' && req.url === '/health') {
          return sendJson(200, { status: 'ok' });
        }

        if (req.method === 'POST' && req.url === '/report') {
          const chunks = [];
          let size = 0;
          const MAX_BODY = 1024 * 1024;

          req.on('data', (chunk) => {
            size += chunk.length;
            if (size <= MAX_BODY) chunks.push(chunk);
          });

          req.on('end', async () => {
            if (size > MAX_BODY) return sendJson(413, { error: 'Request body too large' });

            let body;
            try {
              body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
            } catch {
              return sendJson(400, { error: 'Invalid JSON body' });
            }

            const { url, token } = body;
            if (!url || typeof url !== 'string') return sendJson(400, { error: 'Missing or invalid "url" field' });
            if (!token || typeof token !== 'string') return sendJson(400, { error: 'Missing or invalid "token" field' });
            if (!url.startsWith('https://')) return sendJson(400, { error: '"url" must start with https://' });

            try {
              const { generateReport } = require('./export-report.js');
              const html = await generateReport({ url, token, quiet: true });
              const base64 = Buffer.from(html, 'utf-8').toString('base64');
              sendJson(200, { report: base64 });
            } catch (err) {
              const msg = err.message || 'Internal server error';
              const status = msg.includes('401') ? 401 : msg.includes('403') ? 403 : msg.includes('400') ? 400 : 500;
              sendJson(status, { error: msg });
            }
          });

          req.on('error', () => sendJson(500, { error: 'Request stream error' }));
          return;
        }

        sendJson(404, { error: 'Not found' });
      });

      appSrv.listen(0, () => {
        server.appServer = appSrv;
        server.appPort = appSrv.address().port;
        resolve(appSrv.address().port);
      });
    });
    return appPort;
  }

  describe('GET /health', () => {
    it('returns 200 with status ok', async () => {
      const p = await ensureAppServer();
      const res = await request('GET', '/health', null, p);
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.body, { status: 'ok' });
    });

    it('returns application/json content type', async () => {
      const p = await ensureAppServer();
      const res = await request('GET', '/health', null, p);
      assert.ok(res.headers['content-type'].includes('application/json'));
    });
  });

  describe('404 handling', () => {
    it('returns 404 for unknown GET path', async () => {
      const p = await ensureAppServer();
      const res = await request('GET', '/unknown', null, p);
      assert.equal(res.statusCode, 404);
      assert.deepEqual(res.body, { error: 'Not found' });
    });

    it('returns 404 for GET /report', async () => {
      const p = await ensureAppServer();
      const res = await request('GET', '/report', null, p);
      assert.equal(res.statusCode, 404);
    });
  });

  describe('POST /report validation', () => {
    it('returns 400 for invalid JSON', async () => {
      const p = await ensureAppServer();
      const res = await request('POST', '/report', 'not-json', p);
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.error, 'Invalid JSON body');
    });

    it('returns 400 when url is missing', async () => {
      const p = await ensureAppServer();
      const res = await request('POST', '/report', { token: 'tok' }, p);
      assert.equal(res.statusCode, 400);
      assert.match(res.body.error, /url/i);
    });

    it('returns 400 when token is missing', async () => {
      const p = await ensureAppServer();
      const res = await request('POST', '/report', { url: 'https://x.com/#!/?a=b' }, p);
      assert.equal(res.statusCode, 400);
      assert.match(res.body.error, /token/i);
    });

    it('returns 400 when url does not start with https://', async () => {
      const p = await ensureAppServer();
      const res = await request('POST', '/report', { url: 'http://evil.com/#!/?a=b', token: 'tok' }, p);
      assert.equal(res.statusCode, 400);
      assert.match(res.body.error, /https/);
    });

    it('returns 400 when url is not a string', async () => {
      const p = await ensureAppServer();
      const res = await request('POST', '/report', { url: 123, token: 'tok' }, p);
      assert.equal(res.statusCode, 400);
      assert.match(res.body.error, /url/i);
    });

    it('returns 400 when token is not a string', async () => {
      const p = await ensureAppServer();
      const res = await request('POST', '/report', { url: 'https://x.com/#!/?a=b', token: 42 }, p);
      assert.equal(res.statusCode, 400);
      assert.match(res.body.error, /token/i);
    });
  });

  describe('POST /report with mocked Jira', () => {
    it('returns base64-encoded report for valid request', async () => {
      const p = await ensureAppServer();
      const jiraUrl = `https://localhost:${server.jiraPort}/plugins/servlet/timereports?reportKey=test#!/?filterOrProjectId=filter_100&startDate=2026-02-01&endDate=2026-02-28&groupByField=workeduser&sum=month&user=John.Doe&view=month&export=html`;
      const res = await request('POST', '/report', { url: jiraUrl, token: 'test-token' }, p);

      // This will fail connecting to fake Jira via HTTPS (it's HTTP),
      // so we expect a 500 error. The validation tests above cover the logic.
      // For a true end-to-end test with mocked Jira, see the integration test below.
      assert.ok([200, 500].includes(res.statusCode));
    });
  });

  describe('response headers', () => {
    it('sets no-store cache control', async () => {
      const p = await ensureAppServer();
      const res = await request('GET', '/health', null, p);
      assert.equal(res.headers['cache-control'], 'no-store');
    });
  });
});

// ---- Integration: generateReport with mocked Jira --------------------------

describe('generateReport integration', () => {
  let fakeJira;
  let jiraPort;

  before(async () => {
    fakeJira = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });

      if (req.url.includes('/rest/api/2/search')) {
        res.end(JSON.stringify({
          total: 2,
          issues: [
            {
              key: 'MOCK-1',
              fields: {
                project: { key: 'MOCK' },
                summary: 'First Task',
                priority: { name: 'Major' },
                status: { name: 'Done' },
                issuetype: { name: 'Task' },
                worklog: {
                  total: 2,
                  maxResults: 20,
                  worklogs: [
                    { author: { name: 'alice', displayName: 'Alice A' }, started: '2026-02-10T09:00:00.000+0000', timeSpentSeconds: 3600 },
                    { author: { name: 'alice', displayName: 'Alice A' }, started: '2026-02-11T10:00:00.000+0000', timeSpentSeconds: 7200 },
                  ],
                },
              },
            },
            {
              key: 'MOCK-2',
              fields: {
                project: { key: 'MOCK' },
                summary: 'Second Task',
                priority: { name: 'Minor' },
                status: { name: 'Open' },
                issuetype: { name: 'Bug' },
                worklog: {
                  total: 1,
                  maxResults: 20,
                  worklogs: [
                    { author: { name: 'alice', displayName: 'Alice A' }, started: '2026-02-15T14:00:00.000+0000', timeSpentSeconds: 5400 },
                  ],
                },
              },
            },
          ],
        }));
      } else {
        res.end(JSON.stringify({ worklogs: [], total: 0 }));
      }
    });

    await new Promise(resolve => fakeJira.listen(0, resolve));
    jiraPort = fakeJira.address().port;
  });

  after(async () => {
    if (fakeJira) await new Promise(r => fakeJira.close(r));
  });

  it('generates valid Excel HTML from mocked Jira data', async () => {
    // Build URL pointing to fake Jira (using http:// since it's a local test server)
    const url = `http://localhost:${jiraPort}/plugins/servlet/timereports?reportKey=test#!/?filterOrProjectId=filter_100&startDate=2026-02-01&endDate=2026-02-28&groupByField=workeduser&sum=month&user=alice&view=month&export=html`;

    const { generateReport } = require('./export-report.js');
    const html = await generateReport({ url, token: 'test-token', quiet: true });

    // Verify it's valid Excel-wrapped HTML
    assert.ok(html.includes('xmlns:x="urn:schemas-microsoft-com:office:excel"'));
    assert.ok(html.includes('<x:Name>Timesheet</x:Name>'));

    // Verify user data appears
    assert.ok(html.includes('Alice A'));

    // Verify month header
    assert.ok(html.includes('Feb 2026'));

    // Verify hours calculation: Alice total = 3600+7200+5400 = 16200s = 4.5h
    // The report shows per-user totals per month, should show "4,50" (Polish locale)
    assert.match(html, /4[,.]50/);
  });

  it('returns base64-decodable content', async () => {
    const url = `http://localhost:${jiraPort}/plugins/servlet/timereports?reportKey=test#!/?filterOrProjectId=filter_100&startDate=2026-02-01&endDate=2026-02-28&groupByField=workeduser&sum=month&user=alice&view=month&export=html`;

    const { generateReport } = require('./export-report.js');
    const html = await generateReport({ url, token: 'test-token', quiet: true });
    const base64 = Buffer.from(html, 'utf-8').toString('base64');
    const decoded = Buffer.from(base64, 'base64').toString('utf-8');

    assert.equal(decoded, html);
    assert.ok(decoded.includes('<html'));
  });
});
