// OpenAI-compatible shim over Anthropic's own Claude Code CLI (`claude -p`).
//
// Why this shape: Anthropic permits an end user to sign in to the *unmodified*
// Claude Code binary with their own Claude subscription, and prohibits a
// third-party app from holding Claude.ai credentials or talking to the API as
// Claude Code. So this process never speaks to Anthropic itself: it hands one
// prompt to the real CLI and returns whatever the CLI prints. If the
// subscription stops working, the only thing to replace is this container.
//
// Credential precedence matches the CLI's own: in -p mode an API key always
// wins over the subscription token, so the mode is decided by which one exists.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.PORT || 8080);
const OAUTH = String(process.env.CLAUDE_CODE_OAUTH_TOKEN || '').trim();
const API_KEY = String(process.env.ANTHROPIC_API_KEY || '').trim();
const MODE = API_KEY ? 'api-key' : OAUTH ? 'subscription' : 'unconfigured';
const BIN = process.env.CLAUDE_BIN || 'claude';
const TIMEOUT_MS = Number(process.env.BRIDGE_TIMEOUT_MS || 95000);

// One model call at a time: a single subscription seat, and serialized traffic
// is the least likely to look like a quota-harvesting proxy to abuse filters.
const MAX_QUEUE = 20;
let running = 0;
const waiters = [];
function acquire() {
  if (running === 0) {
    running = 1;
    return Promise.resolve();
  }
  if (waiters.length >= MAX_QUEUE) {
    return Promise.reject(Object.assign(new Error('bridge queue full'), { status: 503, code: 'queue_full' }));
  }
  return new Promise((resolve) => waiters.push(resolve));
}
function release() {
  const next = waiters.shift();
  if (next) next();
  else running = 0;
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 2_000_000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

function parseOuterJson(text) {
  const t = String(text || '').trim();
  try {
    return JSON.parse(t);
  } catch {
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(t.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

// The trailer matters more than the message: the workflow decides between a
// retry and a human escalation from these codes, not from CLI prose.
// Observed shapes (CLI 2.1.331): no credential -> result "Not logged in · Please
// run /login"; bad key -> api_error_status 401, result "Invalid API key · Fix
// external API key". Both arrive with exit code 1 and is_error: true.
function classify(code, err, out, parsed) {
  const text = String((parsed && parsed.result) || '');
  const blob = `${text} ${err} ${out}`.toLowerCase();
  const apiStatus = Number(parsed && parsed.api_error_status) || null;
  const message = (text || err.trim() || out.trim() || `claude exited with code ${code}`).slice(0, 400);

  if (/only authorized for use with claude code|cannot be used for other api requests/.test(blob)) {
    return { ok: false, status: 401, code: 'credential_rejected', message };
  }
  if (apiStatus === 429 || /hit your (session|weekly|opus|sonnet) limit|usage limit|rate.?limit|out of extra usage/.test(blob)) {
    return { ok: false, status: 429, code: 'usage_limit', message };
  }
  if (apiStatus === 401 || apiStatus === 403 || /not logged in|please run \/login|invalid api key|oauth token.{0,20}(invalid|expired)/.test(blob)) {
    return { ok: false, status: 401, code: 'auth_expired', message };
  }
  return { ok: false, status: 502, code: 'cli_error', message };
}

async function runClaude(system, user) {
  const cwd = await mkdtemp(join(tmpdir(), 'ithd-'));
  try {
    const args = [
      '-p',
      '--output-format', 'json',
      // A triage call must classify, never touch the machine.
      '--tools', '',
      '--disallowedTools', 'mcp__*',
      '--max-turns', '1',
      '--no-session-persistence',
    ];
    if (system) args.push('--system-prompt', system);

    return await new Promise((resolve) => {
      let done = false;
      let out = '';
      let err = '';
      const child = spawn(BIN, args, {
        cwd,
        env: { ...process.env, HOME: process.env.HOME || cwd },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const finish = (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 3000);
        finish({ ok: false, status: 504, code: 'bridge_timeout', message: `model call exceeded ${TIMEOUT_MS}ms` });
      }, TIMEOUT_MS);

      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', (e) =>
        finish({ ok: false, status: 502, code: 'cli_missing', message: `could not run ${BIN}: ${e.message}` }));
      child.on('close', (code) => {
        const parsed = parseOuterJson(out);
        // The CLI reports errors with is_error and can still exit 0, so never
        // trust the exit code alone.
        const text = parsed ? (typeof parsed.result === 'string' ? parsed.result : '') : out.trim();
        if (code === 0 && text && !(parsed && parsed.is_error)) finish({ ok: true, text });
        else finish(classify(code, err, out, parsed));
      });
      child.stdin.on('error', () => {});
      child.stdin.end(user);
    });
  } finally {
    rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/health')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: MODE !== 'unconfigured', mode: MODE, queued: waiters.length }));
  }

  if (req.method === 'POST' && req.url.includes('/chat/completions')) {
    const body = await readBody(req);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const system = messages.filter((m) => m.role === 'system').map((m) => String(m.content || '')).join('\n\n');
    const user = String((messages.filter((m) => m.role === 'user').pop() || {}).content || '');

    const fail = (status, code, message) => {
      res.writeHead(status, { 'content-type': 'application/json', 'x-bridge-error': code });
      res.end(JSON.stringify({ error: { message, type: 'bridge_error', code } }));
    };

    if (MODE === 'unconfigured') {
      return fail(503, 'not_configured', 'No Claude credential in the bridge. Set CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) in .env and restart claude-bridge.');
    }
    if (!user) return fail(400, 'no_prompt', 'Request had no user message.');
    const auth = String(req.headers.authorization || '');
    if (!auth.startsWith('Bearer ')) return fail(401, 'unauthorized', 'Missing bearer token.');

    let acquired = false;
    try {
      await acquire();
      acquired = true;
      const started = Date.now();
      const result = await runClaude(system, user);
      if (!result.ok) {
        console.log(`[bridge] ${result.code} after ${Date.now() - started}ms: ${result.message.slice(0, 200)}`);
        return fail(result.status, result.code, result.message);
      }
      console.log(`[bridge] ok in ${Date.now() - started}ms (mode=${MODE})`);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(
        JSON.stringify({
          id: `chatcmpl-bridge-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: body.model || 'claude-code-bridge',
          choices: [{ index: 0, message: { role: 'assistant', content: result.text }, finish_reason: 'stop' }],
        }),
      );
    } catch (e) {
      return fail(e.status || 500, e.code || 'bridge_error', e.message);
    } finally {
      if (acquired) release();
    }
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`claude-bridge listening on :${PORT} (mode=${MODE}, bin=${BIN})`);
  if (MODE === 'unconfigured') {
    console.log('claude-bridge: no credential set - every call returns 503 so the workflow escalates to a human.');
  }
});
