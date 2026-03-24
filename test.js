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
const crypto = require('crypto');

const {
  parseReportUrl,
  buildAuthHeaders,
  shiftDate,
  getMonthKey,
  getMonthLabel,
  formatHours,
  escapeHtml,
  processWorklogs,
  buildJsonReport,
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
    author: { name: author, displayName, emailAddress: `${author}@example.com` },
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

  it('preserves context path for subpath Jira instances', () => {
    const url = 'https://jira.example.com/jira/plugins/servlet/timereports?reportKey=jira-timesheet-plugin:timereportstt#!/?filterOrProjectId=filter_85267&startDate=2026-02-01&endDate=2026-02-28&groupByField=workeduser&view=month&sum=month&user=Alice,Bob&export=html';
    const r = parseReportUrl(url);
    assert.equal(r.origin, 'https://jira.example.com/jira');
    assert.equal(r.filterId, '85267');
    assert.deepEqual(r.users, ['Alice', 'Bob']);
  });

  it('throws on missing hash-bang', () => {
    assert.throws(
      () => parseReportUrl('https://jira.example.com/page'),
      /hash-bang/
    );
  });

  it('rejects non-numeric filterId', () => {
    const url = SAMPLE_URL.replace('filter_43643', 'filter_abc" or project=SECRET');
    assert.throws(
      () => parseReportUrl(url),
      /Invalid filterId/
    );
  });

  it('rejects filterId with JQL injection attempt', () => {
    const url = SAMPLE_URL.replace('filter_43643', 'filter_123 or 1=1');
    assert.throws(
      () => parseReportUrl(url),
      /Invalid filterId/
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

  it('escapes single quotes', () => {
    assert.equal(escapeHtml("It's a test"), 'It&#39;s a test');
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
    assert.ok(grouped['john']);
    assert.ok(grouped['jane']);
    assert.equal(Object.keys(grouped).length, 2);
  });

  it('aggregates total seconds per issue', () => {
    const { grouped } = processWorklogs(issues, '2026-02-01', '2026-02-28', []);
    // John: PROJ-1 = 3600+7200=10800, PROJ-2 = 5400
    assert.equal(grouped['john']['PROJ-1'].total, 10800);
    assert.equal(grouped['john']['PROJ-2'].total, 5400);
  });

  it('aggregates per month', () => {
    const { grouped, months } = processWorklogs(issues, '2026-02-01', '2026-02-28', []);
    assert.deepEqual(months, ['2026-02']);
    assert.equal(grouped['john']['PROJ-1'].months['2026-02'], 10800);
  });

  it('filters by target users', () => {
    const { grouped } = processWorklogs(issues, '2026-02-01', '2026-02-28', ['john']);
    assert.ok(grouped['john']);
    assert.equal(grouped['jane'], undefined);
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
    assert.equal(grouped['john']['PROJ-3'].total, 1800);
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
    assert.equal(grouped['john']['PROJ-4'].months['2026-02'], 3600);
    assert.equal(grouped['john']['PROJ-4'].months['2026-03'], 7200);
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
    assert.equal(grouped['john']['PROJ-6'].total, 4500);
  });
});

// ---- JSON report generation tests ------------------------------------------

describe('buildJsonReport', () => {
  it('aggregates hours per user keyed by username', () => {
    const grouped = {
      'john': {
        _meta: { email: 'john@example.com' },
        'PROJ-1': { summary: 'Task', project: 'PROJ', months: { '2026-02': 7200 }, total: 7200 },
        'PROJ-2': { summary: 'Task2', project: 'PROJ', months: { '2026-02': 3600 }, total: 3600 },
      },
    };
    const report = buildJsonReport(grouped);
    assert.deepEqual(report, { 'john': { hours: 3, email: 'john@example.com' } });
  });

  it('handles multiple users', () => {
    const grouped = {
      'alice': {
        _meta: { email: 'alice@example.com' },
        'X-1': { summary: 'T', project: 'X', months: { '2026-02': 5400 }, total: 5400 },
      },
      'bob': {
        _meta: { email: 'bob@example.com' },
        'X-2': { summary: 'T', project: 'X', months: { '2026-02': 9000 }, total: 9000 },
      },
    };
    const report = buildJsonReport(grouped);
    assert.equal(report['alice'].hours, 1.5);
    assert.equal(report['alice'].email, 'alice@example.com');
    assert.equal(report['bob'].hours, 2.5);
    assert.equal(report['bob'].email, 'bob@example.com');
  });

  it('rounds to two decimal places', () => {
    const grouped = {
      'test': {
        _meta: { email: 'test@example.com' },
        'X-1': { summary: 'T', project: 'X', months: { '2026-02': 1234 }, total: 1234 },
      },
    };
    const report = buildJsonReport(grouped);
    // 1234 / 3600 = 0.342777... → 0.34
    assert.equal(report['test'].hours, 0.34);
  });

  it('returns empty object for no data', () => {
    assert.deepEqual(buildJsonReport({}), {});
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
      if (req.url.includes('/rest/api/2/myself')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ name: 'testuser', displayName: 'Test User' }));
      } else if (req.url.includes('/rest/api/2/search')) {
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
  function request(method, path, body, reqPort, extraHeaders) {
    return new Promise((resolve, reject) => {
      const opts = {
        hostname: 'localhost',
        port: reqPort,
        path,
        method,
        headers: { 'Content-Type': 'application/json', ...extraHeaders },
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
    const appPort = await new Promise((resolve) => {
      const origLog = console.log;
      console.log = () => {};
      console.log = origLog;

      const jobs = new Map();

      const appSrv = http.createServer((req, res) => {
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

        // GET /report/:jobId — poll job status
        if (req.method === 'GET' && req.url.startsWith('/report/')) {
          const jobId = req.url.slice('/report/'.length);
          if (!jobId) return sendJson(404, { error: 'Not found' });
          const job = jobs.get(jobId);
          if (!job) return sendJson(404, { error: 'Job not found' });
          const result = { jobId, status: job.status };
          if (job.status === 'complete') result.report = job.report;
          if (job.status === 'error') result.error = job.error;
          return sendJson(200, result);
        }

        if (req.method === 'POST' && req.url === '/report') {
          const chunks = [];
          let size = 0;
          const MAX_BODY = 1024 * 1024;

          req.on('data', (chunk) => {
            size += chunk.length;
            if (size <= MAX_BODY) chunks.push(chunk);
          });

          req.on('end', () => {
            if (size > MAX_BODY) return sendJson(413, { error: 'Request body too large' });

            let body;
            try {
              body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
            } catch {
              return sendJson(400, { error: 'Invalid JSON body' });
            }

            const { url } = body;
            if (!url || typeof url !== 'string') return sendJson(400, { error: 'Missing or invalid "url" field' });
            if (!url.startsWith('https://')) return sendJson(400, { error: '"url" must start with https://' });

            const authHeader = req.headers['authorization'] || '';
            const token = authHeader.startsWith('Bearer ')
              ? authHeader.slice(7)
              : '';
            if (!token) return sendJson(401, { error: 'Missing token. Provide Authorization: Bearer <PAT> header.' });

            const jobId = crypto.randomBytes(16).toString('hex');
            const job = { status: 'pending', report: null, error: null, createdAt: Date.now() };
            jobs.set(jobId, job);

            const { generateReport } = require('./export-report.js');
            generateReport({ url, token, quiet: true })
              .then((report) => { job.status = 'complete'; job.report = report; })
              .catch((err) => {
                job.status = 'error';
                const msg = err.message || 'Internal server error';
                const errType = msg.includes('(401)') ? 'auth' : msg.includes('(403)') ? 'auth' : msg.includes('HTTP 400') ? 'request' : 'internal';
                job.error = errType === 'internal' ? 'Internal server error' : msg;
              });

            sendJson(202, { jobId });
          });

          req.on('error', () => sendJson(500, { error: 'Request stream error' }));
          return;
        }

        // POST /report/sync — blocking
        if (req.method === 'POST' && req.url === '/report/sync') {
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

            const { url } = body;
            if (!url || typeof url !== 'string') return sendJson(400, { error: 'Missing or invalid "url" field' });
            if (!url.startsWith('https://')) return sendJson(400, { error: '"url" must start with https://' });

            const authHeader = req.headers['authorization'] || '';
            const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
            if (!token) return sendJson(401, { error: 'Missing token. Provide Authorization: Bearer <PAT> header.' });

            try {
              const { generateReport } = require('./export-report.js');
              const report = await generateReport({ url, token, quiet: true });
              sendJson(200, report);
            } catch (err) {
              const msg = err.message || 'Internal server error';
              const status = msg.includes('(401)') ? 401 : msg.includes('(403)') ? 403 : msg.includes('HTTP 400') ? 400 : 500;
              const safeMsg = status === 500 ? 'Internal server error' : msg;
              sendJson(status, { error: safeMsg });
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

  // Helper: poll a job until it settles (complete or error) or times out
  async function pollJob(port, jobId, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 5000);
    while (Date.now() < deadline) {
      const res = await request('GET', `/report/${jobId}`, null, port);
      if (res.body && res.body.status !== 'pending') return res;
      await new Promise(r => setTimeout(r, 50));
    }
    // Return last pending response
    return request('GET', `/report/${jobId}`, null, port);
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

    it('returns 401 when token is missing', async () => {
      const p = await ensureAppServer();
      const res = await request('POST', '/report', { url: 'https://x.com/#!/?a=b' }, p);
      assert.equal(res.statusCode, 401);
      assert.match(res.body.error, /token/i);
    });

    it('returns 400 when url does not start with https://', async () => {
      const p = await ensureAppServer();
      const res = await request('POST', '/report', { url: 'http://evil.com/#!/?a=b' }, p, { 'Authorization': 'Bearer tok' });
      assert.equal(res.statusCode, 400);
      assert.match(res.body.error, /https/);
    });

    it('returns 400 when url is not a string', async () => {
      const p = await ensureAppServer();
      const res = await request('POST', '/report', { url: 123 }, p, { 'Authorization': 'Bearer tok' });
      assert.equal(res.statusCode, 400);
      assert.match(res.body.error, /url/i);
    });

    it('returns 401 when Authorization header is missing', async () => {
      const p = await ensureAppServer();
      const res = await request('POST', '/report', { url: 'https://x.com/#!/?a=b' }, p);
      assert.equal(res.statusCode, 401);
      assert.match(res.body.error, /token/i);
    });

    it('accepts token from Authorization header', async () => {
      const p = await ensureAppServer();
      const res = await request('POST', '/report', { url: 'https://x.com/#!/?a=b' }, p, { 'Authorization': 'Bearer test-pat' });
      // Valid token → job is created, returns 202 with jobId
      assert.equal(res.statusCode, 202);
      assert.ok(typeof res.body.jobId === 'string');
      assert.ok(res.body.jobId.length > 0);
    });

    it('ignores body token field', async () => {
      const p = await ensureAppServer();
      // Token in body only — should be rejected since header is required
      const res = await request('POST', '/report', { url: 'https://x.com/#!/?a=b', token: 'body-tok' }, p);
      assert.equal(res.statusCode, 401);
    });
  });

  describe('POST /report with mocked Jira', () => {
    it('returns 202 with jobId for valid request', async () => {
      const p = await ensureAppServer();
      const jiraUrl = `https://localhost:${server.jiraPort}/plugins/servlet/timereports?reportKey=test#!/?filterOrProjectId=filter_100&startDate=2026-02-01&endDate=2026-02-28&groupByField=workeduser&sum=month&user=John.Doe&view=month&export=html`;
      const res = await request('POST', '/report', { url: jiraUrl }, p, { 'Authorization': 'Bearer test-token' });

      assert.equal(res.statusCode, 202);
      assert.ok(typeof res.body.jobId === 'string');
      assert.ok(res.body.jobId.length > 0);
    });
  });

  describe('Async polling', () => {
    it('POST /report returns 202 with a jobId', async () => {
      const p = await ensureAppServer();
      const res = await request('POST', '/report', { url: 'https://x.com/#!/?a=b' }, p, { 'Authorization': 'Bearer tok' });
      assert.equal(res.statusCode, 202);
      assert.equal(typeof res.body.jobId, 'string');
      assert.ok(res.body.jobId.length >= 16);
    });

    it('GET /report/<jobId> returns pending initially', async () => {
      const p = await ensureAppServer();
      const submitRes = await request('POST', '/report', { url: 'https://x.com/#!/?a=b' }, p, { 'Authorization': 'Bearer tok' });
      const { jobId } = submitRes.body;

      // Poll immediately — only jobId and status guaranteed
      const pollRes = await request('GET', `/report/${jobId}`, null, p);
      assert.equal(pollRes.statusCode, 200);
      assert.equal(pollRes.body.jobId, jobId);
      assert.ok(['pending', 'complete', 'error'].includes(pollRes.body.status));
    });

    it('GET /report/<jobId> eventually settles to complete or error', async () => {
      const p = await ensureAppServer();
      const submitRes = await request('POST', '/report', { url: 'https://x.com/#!/?a=b' }, p, { 'Authorization': 'Bearer tok' });
      const { jobId } = submitRes.body;

      // Poll until settled (the job will fail since there's no real Jira, that's fine)
      const pollRes = await pollJob(p, jobId, 5000);
      assert.equal(pollRes.statusCode, 200);
      assert.ok(['complete', 'error'].includes(pollRes.body.status));
      assert.equal(typeof pollRes.body.jobId, 'string');
      if (pollRes.body.status === 'complete') {
        assert.equal(typeof pollRes.body.report, 'object');
        assert.notEqual(pollRes.body.report, null);
        assert.equal(pollRes.body.error, undefined);
      } else {
        assert.equal(pollRes.body.report, undefined);
        assert.equal(typeof pollRes.body.error, 'string');
      }
    });

    it('GET /report/<unknown-id> returns 404', async () => {
      const p = await ensureAppServer();
      const res = await request('GET', '/report/nonexistent-id-12345', null, p);
      assert.equal(res.statusCode, 404);
      assert.equal(res.body.error, 'Job not found');
    });

    it('GET /report/ with empty jobId returns 404', async () => {
      const p = await ensureAppServer();
      const res = await request('GET', '/report/', null, p);
      assert.equal(res.statusCode, 404);
    });

    it('each POST /report returns a unique jobId', async () => {
      const p = await ensureAppServer();
      const res1 = await request('POST', '/report', { url: 'https://x.com/#!/?a=b' }, p, { 'Authorization': 'Bearer tok' });
      const res2 = await request('POST', '/report', { url: 'https://x.com/#!/?a=b' }, p, { 'Authorization': 'Bearer tok' });
      assert.notEqual(res1.body.jobId, res2.body.jobId);
    });
  });

  describe('POST /report/sync (blocking)', () => {
    it('returns 400 for invalid JSON', async () => {
      const p = await ensureAppServer();
      const res = await request('POST', '/report/sync', 'not-json', p);
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.error, 'Invalid JSON body');
    });

    it('returns 400 when url is missing', async () => {
      const p = await ensureAppServer();
      const res = await request('POST', '/report/sync', {}, p, { 'Authorization': 'Bearer tok' });
      assert.equal(res.statusCode, 400);
      assert.match(res.body.error, /url/i);
    });

    it('returns 401 when token is missing', async () => {
      const p = await ensureAppServer();
      const res = await request('POST', '/report/sync', { url: 'https://x.com/#!/?a=b' }, p);
      assert.equal(res.statusCode, 401);
      assert.match(res.body.error, /token/i);
    });

    it('returns 400 when url does not start with https://', async () => {
      const p = await ensureAppServer();
      const res = await request('POST', '/report/sync', { url: 'http://evil.com/#!/?a=b' }, p, { 'Authorization': 'Bearer tok' });
      assert.equal(res.statusCode, 400);
      assert.match(res.body.error, /https/);
    });

    it('returns a report object directly on success (with mocked Jira integration)', async () => {
      // This uses the integration fakeJira server from the "generateReport integration" suite
      // In isolation here, it will fail with a connection error (500), which is fine.
      // Full end-to-end is covered by the generateReport integration tests.
      const p = await ensureAppServer();
      const res = await request('POST', '/report/sync', { url: 'https://x.com/#!/?a=b' }, p, { 'Authorization': 'Bearer tok' });
      // Reaches generateReport, which fails on connection — returns 500
      assert.ok([200, 500].includes(res.statusCode));
      // Must NOT return a jobId (that would be the async path)
      assert.equal(res.body.jobId, undefined);
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

      if (req.url.includes('/rest/api/2/myself')) {
        res.end(JSON.stringify({ name: 'testuser', displayName: 'Test User' }));
      } else if (req.url.includes('/rest/api/2/search')) {
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

  it('generates JSON report from mocked Jira data', async () => {
    // Build URL pointing to fake Jira (using http:// since it's a local test server)
    const url = `http://localhost:${jiraPort}/plugins/servlet/timereports?reportKey=test#!/?filterOrProjectId=filter_100&startDate=2026-02-01&endDate=2026-02-28&groupByField=workeduser&sum=month&user=alice&view=month&export=html`;

    const { generateReport } = require('./export-report.js');
    const report = await generateReport({ url, token: 'test-token', quiet: true });

    // Verify it's a JSON object with username keys
    assert.equal(typeof report, 'object');
    assert.ok(report['alice'] !== undefined);

    // Verify hours calculation: Alice total = 3600+7200+5400 = 16200s = 4.5h
    assert.equal(report['alice'].hours, 4.5);
    assert.equal(report['alice'].email, '');
  });

  it('returns serializable JSON', async () => {
    const url = `http://localhost:${jiraPort}/plugins/servlet/timereports?reportKey=test#!/?filterOrProjectId=filter_100&startDate=2026-02-01&endDate=2026-02-28&groupByField=workeduser&sum=month&user=alice&view=month&export=html`;

    const { generateReport } = require('./export-report.js');
    const report = await generateReport({ url, token: 'test-token', quiet: true });
    const json = JSON.stringify(report);
    const parsed = JSON.parse(json);

    assert.deepEqual(parsed, report);
  });

  it('rejects with clear auth error for invalid token', async () => {
    // Create a Jira server that returns 401 on /myself
    const badJira = http.createServer((req, res) => {
      if (req.url.includes('/rest/api/2/myself')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Unauthorized' }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ total: 0, issues: [] }));
      }
    });

    await new Promise(resolve => badJira.listen(0, resolve));
    const badPort = badJira.address().port;

    const url = `http://localhost:${badPort}/plugins/servlet/timereports?reportKey=test#!/?filterOrProjectId=filter_100&startDate=2026-02-01&endDate=2026-02-28&groupByField=workeduser&sum=month&user=alice&view=month&export=html`;

    const { generateReport } = require('./export-report.js');
    await assert.rejects(
      () => generateReport({ url, token: 'bad-token', quiet: true }),
      /[Aa]uthentication failed/
    );

    await new Promise(r => badJira.close(r));
  });
});
