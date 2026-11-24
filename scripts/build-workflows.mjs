// Builds the importable n8n workflows in ./workflows from readable source.
//   node scripts/build-workflows.mjs
// The generated JSON is what n8n actually imports; edit here, not in the JSON.
import { writeFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const PG = { postgres: { id: 'ithd-postgres', name: 'IT Helpdesk Postgres' } };
const NOOP = 'n8n-nodes-base.noOp';

class Flow {
  constructor(name, id) {
    this.name = name;
    this.workflowId = id;
    this.nodes = [];
    this.conns = {};
  }
  add(name, type, typeVersion, position, parameters = {}, extra = {}) {
    // tolerate [X(i), y] call sites where X(i) already returns a pair
    const pos = Array.isArray(position[0]) ? [position[0][0], position[1] ?? 0] : position;
    this.nodes.push({
      parameters,
      id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      name,
      type,
      typeVersion,
      position: pos,
      ...extra,
    });
    return name;
  }
  connect(from, to, out = 0, input = 0) {
    const c = (this.conns[from] = this.conns[from] || { main: [] });
    while (c.main.length <= out) c.main.push([]);
    c.main[out].push({ node: to, type: 'main', index: input });
  }
  // convenience: connect every source to one target
  connectAll(sources, to, out = 0) {
    for (const s of sources) this.connect(s, to, out);
  }
  json() {
    return {
      id: this.workflowId,
      name: this.name,
      nodes: this.nodes,
      connections: this.conns,
      active: false,
      settings: { executionOrder: 'v1' },
      versionId: randomUUID(),
      meta: { templateCredsSetupCompleted: false },
      pinData: {},
      tags: [],
    };
  }
  save() {
    mkdirSync('workflows', { recursive: true });
    const file = `workflows/${this.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`;
    writeFileSync(file, JSON.stringify(this.json(), null, 2) + '\n');
    console.log(`wrote ${file} (${this.nodes.length} nodes)`);
  }
}

// ---------------------------------------------------------------------------
// small builders
// ---------------------------------------------------------------------------
const pg = (f, name, position, query, replacement = null, extra = {}) =>
  f.add(name, 'n8n-nodes-base.postgres', 2.4, position, {
    operation: 'executeQuery',
    query,
    options: replacement ? { queryReplacement: replacement } : {},
  }, { credentials: PG, ...extra });

const code = (f, name, position, jsCode) =>
  f.add(name, 'n8n-nodes-base.code', 2, position, { jsCode });

const httpPost = (f, name, position, { url, body, headers = [], onError, timeout = 60000, extra = {} }) =>
  f.add(name, 'n8n-nodes-base.httpRequest', 4.2, position, {
    method: 'POST',
    url,
    sendHeaders: true,
    headerParameters: { parameters: headers },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: body,
    options: { timeout },
  }, { ...(onError ? { onError } : {}), ...extra });

const HELP_HEADERS = [
  { name: 'x-api-key', value: '={{ $env.HELPDESK_API_KEY }}' },
  { name: 'content-type', value: 'application/json' },
];

const boolIf = (f, name, position, leftValue) =>
  f.add(name, 'n8n-nodes-base.if', 2, position, {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
      conditions: [{
        id: 'c1',
        leftValue,
        rightValue: '',
        operator: { type: 'boolean', operation: 'true', singleValue: true },
      }],
      combinator: 'and',
    },
    options: {},
  });

const stringIf = (f, name, position, leftValue, operation = 'notEmpty', rightValue = '') =>
  f.add(name, 'n8n-nodes-base.if', 2, position, {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
      conditions: [{
        id: 'c1',
        leftValue,
        rightValue,
        operator: operation === 'notEmpty'
          ? { type: 'string', operation: 'notEmpty', singleValue: true }
          : { type: 'string', operation: 'equals' },
      }],
      combinator: 'and',
    },
    options: {},
  });

// every Webhook node needs a webhookId, otherwise n8n registers the URL as
// {workflowId}/{nodeName}/... instead of the plain path.
const webhookNode = (f, name, position, httpMethod, path) =>
  f.add(name, 'n8n-nodes-base.webhook', 2, position, {
    httpMethod,
    path,
    responseMode: 'responseNode',
    options: {},
  }, { webhookId: randomUUID() });

const respondJson = (f, name, position, body, code = 200) =>
  f.add(name, 'n8n-nodes-base.respondToWebhook', 1.1, position, {
    respondWith: 'json',
    responseBody: body,
    options: { responseCode: code },
  });

const respondHtml = (f, name, position, body, code = 200) =>
  f.add(name, 'n8n-nodes-base.respondToWebhook', 1.1, position, {
    respondWith: 'text',
    responseBody: body,
    options: {
      responseCode: code,
      responseHeaders: { entries: [{ name: 'content-type', value: 'text/html; charset=utf-8' }] },
    },
  });

// ===========================================================================
// WORKFLOW 1 — IT helpdesk triage
// ===========================================================================
function triage() {
  const f = new Flow('IT Helpdesk - AI Triage', 'ithdTriageWf0001');
  const X = (i) => [i * 260, 0];

  webhookNode(f, 'Ticket Webhook', X(0), 'POST', 'it-helpdesk/ticket');

  code(f, 'Normalize Ticket', X(1), `
const body = ($json.body && typeof $json.body === 'object') ? $json.body : $json;
const headers = $json.headers || {};
const pick = (...keys) => {
  for (const k of keys) {
    const v = body[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return null;
};
const email = pick('requester_email','employee_email','email','user_email','userEmail') || headers['x-employee-email'] || '';
const description = String(pick('description','body','message','text','details','summary') || '');
const ticketId = String(pick('ticket_id','id','ticketId','number') || ('TCK-' + Date.now()));
return [{ json: {
  ticket_id: ticketId,
  external_id: String(pick('external_id','id') || ticketId),
  employee_email: String(email).toLowerCase().trim(),
  employee_name: String(pick('requester_name','employee_name','name','user_name') || ''),
  subject: String(pick('subject','title') || description.slice(0, 90) || 'No subject'),
  description,
  priority: String(pick('priority') || 'normal').toLowerCase(),
  category_hint: pick('category') || null,
  source: String(pick('source') || 'helpdesk'),
  received_at: new Date().toISOString(),
  has_email: Boolean(String(email).trim()),
} }];`);

  boolIf(f, 'If Ticket Valid', X(2), '={{ $json.has_email }}');

  respondJson(f, 'Reject Ticket', [X(2), 220], '={{ JSON.stringify({ accepted: false, error: "ticket requires requester_email / employee_email" }) }}', 400);

  respondJson(f, 'Accept Ticket', X(3), '={{ JSON.stringify({ accepted: true, ticket_id: $json.ticket_id, status: "processing", message: "Ticket accepted, AI triage started." }) }}', 202);

  pg(f, 'Upsert Ticket', X(4), `
INSERT INTO tickets (id, external_id, employee_email, employee_name, subject, description, category, status, source)
VALUES ($1,$2,$3,$4,$5,$6,$7,'processing',$8)
ON CONFLICT (id) DO UPDATE SET
  subject = EXCLUDED.subject,
  description = EXCLUDED.description,
  employee_email = EXCLUDED.employee_email,
  status = 'processing',
  updated_at = now()
RETURNING id, status;`,
  '={{ [ $json.ticket_id, $json.external_id, $json.employee_email, $json.employee_name, $json.subject, $json.description, $json.category_hint, $json.source ] }}');

  f.add('Read IT Config', 'n8n-nodes-base.readWriteFile', 1, X(5), {
    fileSelector: '/data/it-config.json',
    options: {},
  });

  f.add('Extract Config Text', 'n8n-nodes-base.extractFromFile', 1, X(6), {
    operation: 'text',
    binaryPropertyName: 'data',
    options: {},
  });

  code(f, 'Parse Config', X(7), `
const raw = $json.data ?? $json.text ?? '';
const cfg = typeof raw === 'string' ? JSON.parse(raw) : raw;
return [{ json: cfg }];`);

  f.add('Read Inventory Sheet', 'n8n-nodes-base.readWriteFile', 1, X(8), {
    fileSelector: '/data/it-inventory.xlsx',
    options: {},
  });

  f.add('Parse Inventory Sheet', 'n8n-nodes-base.extractFromFile', 1, X(9), {
    operation: 'xlsx',
    binaryPropertyName: 'data',
    options: { headerRow: true, includeEmptyCells: false },
  });

  code(f, 'Build AI Request', X(10), `
const cfg = $('Parse Config').first().json;
const ticket = $('Normalize Ticket').first().json;
const rows = $('Parse Inventory Sheet').all().map(i => i.json || {});
const norm = (v) => String(v ?? '').trim();
const email = String(ticket.employee_email || '').toLowerCase();

const employee = rows.find(r => norm(r.email).toLowerCase() === email)
  || rows.find(r => norm(ticket.employee_name) && norm(r.name).toLowerCase() === norm(ticket.employee_name).toLowerCase())
  || null;

const days = (d) => {
  const t = Date.parse(d);
  return Number.isFinite(t) ? Math.max(0, Math.floor((Date.now() - t) / 86400000)) : null;
};

const emp = employee ? {
  ...employee,
  tenure_days: days(employee.start_date),
  installed_software: String(employee.installed_software || '').split(';').map(s => s.trim()).filter(Boolean),
} : null;

const systemPrompt = [
  'You are the AI service-desk agent for ' + ((cfg.company && cfg.company.name) || 'the company') + ' IT department.',
  'You receive one helpdesk ticket, the employee record from the IT inventory sheet, IT policy and the approved software catalog.',
  'Do this:',
  '1. Classify category as one of: software_install, software_issue, hardware_issue, hardware_request, access_request, network, account, other.',
  '2. Ground every factual claim in the employee record (device, OS, installed software, department) and the catalog. Never invent hardware, licenses or software.',
  '3. Write a concrete resolution. For software issues give short numbered steps that match the employee OS.',
  '4. Set requires_admin_decision=true ONLY when a human must authorize something: paid/non-catalog software, access or permission change, hardware allocation, destructive or costly action. Then admin_question is exactly one yes/no question.',
  '5. Never claim you performed an action. Set auto_close=true only when your answer fully resolves the ticket and no IT follow-up is needed.',
  '6. severity: low | medium | high | critical. Use critical for data loss, security or an unusable device.',
  '7. user_message is the reply the employee reads: friendly, short, no jargon, states the next step.',
  '8. it_actions is a short list of what IT must do, or [].',
  '9. hardware.reason: for hardware_request, restate the business reason from the ticket; reason_ok=true only if it is specific.',
  'Return ONLY a JSON object, no markdown, matching:',
  '{"category":"string","severity":"string","confidence":0.0,"diagnosis":"string","resolution":"string","user_message":"string","requires_admin_decision":false,"admin_question":null,"recommended_action":"install_software|check_asset_availability|grant_access|repair_device|investigate|none","requested_software":null,"hardware":{"type":"laptop|monitor|headset|dock|keyboard|mouse|phone","reason":"string"}|null,"reason_ok":true,"auto_close":false,"it_actions":[]}',
].join('\\n');

const userContent = JSON.stringify({
  today: new Date().toISOString().slice(0, 10),
  ticket: {
    id: ticket.ticket_id,
    subject: ticket.subject,
    description: ticket.description,
    priority: ticket.priority,
    category_hint: ticket.category_hint,
    raised_by: { name: ticket.employee_name, email: ticket.employee_email },
  },
  employee: emp,
  inventory_matched: Boolean(emp),
  it_policy: cfg.ai_policy || {},
  software_catalog: (cfg.software_catalog || []).map(s => ({
    name: s.name, slug: s.slug, license: s.license, auto_install: s.auto_install !== false, requires_admin_approval: Boolean(s.requires_admin_approval),
  })),
});

return [{ json: {
  ticket_id: ticket.ticket_id,
  employee: emp,
  inventory_matched: Boolean(emp),
  ticket,
  config: cfg,
  ai_request: {
    model: $env.AI_MODEL || 'gpt-4.1-mini',
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
  },
  // second opinion: one attempt there, then the workflow escalates to a human
  ai_fallback_request: {
    model: $env.AI_FALLBACK_MODEL || 'gpt-4.1-mini',
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
  },
} }];`);

  httpPost(f, 'AI Triage', X(11), {
    url: '={{ $env.AI_BASE_URL + "/chat/completions" }}',
    body: '={{ JSON.stringify($json.ai_request) }}',
    headers: [
      { name: 'Authorization', value: '=Bearer {{ $env.AI_API_KEY }}' },
      { name: 'content-type', value: 'application/json' },
    ],
    onError: 'continueErrorOutput',
    timeout: 90000,
    // No retries on purpose: a rate-limited subscription must not be retried in
    // a loop. One attempt per provider, then a human picks the ticket up.
  });

  // no second provider by default: a failed primary is a human's problem
  stringIf(f, 'If Fallback Configured', [X(12), 200], '={{ $env.AI_FALLBACK_BASE_URL }}');

  httpPost(f, 'AI Fallback', [X(12), 360], {
    url: '={{ ($env.AI_FALLBACK_BASE_URL || "") + "/chat/completions" }}',
    body: "={{ JSON.stringify($('Build AI Request').first().json.ai_fallback_request) }}",
    headers: [
      { name: 'Authorization', value: '=Bearer {{ $env.AI_FALLBACK_API_KEY || $env.AI_API_KEY }}' },
      { name: 'content-type', value: 'application/json' },
    ],
    onError: 'continueErrorOutput',
    timeout: 90000,
  });

  code(f, 'Parse AI Response', X(12), `
const ctx = $('Build AI Request').first().json;
const cfg = ctx.config || {};
const policy = cfg.ai_policy || {};
const raw = (($json.choices || [])[0] || {}).message?.content || '';
const text = String(raw).trim().replace(/^\`\`\`(?:json)?/i, '').replace(/\`\`\`$/, '').trim();
let ai = null;
try { ai = JSON.parse(text); } catch (e) {
  const m = text.match(/\\{[\\s\\S]*\\}/);
  if (m) { try { ai = JSON.parse(m[0]); } catch (e2) { ai = null; } }
}
if (!ai) {
  ai = {
    category: 'other', severity: 'medium', confidence: 0,
    diagnosis: 'AI returned no parsable decision', resolution: '', user_message: '',
    requires_admin_decision: false, auto_close: false, it_actions: ['manual triage'],
  };
}
ai.confidence = Number(ai.confidence ?? 0);
ai.category = String(ai.category || 'other');
ai.severity = String(ai.severity || 'medium');
ai.it_actions = Array.isArray(ai.it_actions) ? ai.it_actions : [];

// --- deterministic policy enforcement (AI classifies, code decides) ---
const catalog = cfg.software_catalog || [];
const wanted = String(ai.requested_software || '').toLowerCase().trim();
const match = wanted ? catalog.find(s =>
  s.slug === wanted ||
  String(s.name).toLowerCase() === wanted ||
  (s.aliases || []).some(a => wanted.includes(String(a).toLowerCase()))
) : null;

if (ai.category === 'software_install' && wanted) {
  if (!match) {
    ai.requires_admin_decision = true;
    ai.admin_question = ai.admin_question || ('The employee asked for "' + ai.requested_software + '", which is not in the approved software catalog. Approve installing it?');
    ai.catalog_match = null;
  } else {
    ai.requested_software = match.name;
    ai.catalog_match = { slug: match.slug, name: match.name, license: match.license || 'unknown' };
    if (match.requires_admin_approval || match.auto_install === false) {
      ai.requires_admin_decision = true;
      ai.admin_question = ai.admin_question || ('Approve a ' + match.name + ' license and installation for this employee?');
    }
  }
}

const minAny = Number(policy.min_confidence_any_action ?? 0.55);
const minAuto = Number(policy.min_confidence_for_autoclose ?? 0.7);
if (ai.severity === 'critical' || ai.confidence < minAny) ai.requires_admin_decision = true;
if ((policy.never_auto_close_severities || []).includes(ai.severity)) ai.auto_close = false;
if ((policy.never_auto_close_categories || []).includes(ai.category)) ai.auto_close = false;
if (ai.confidence < minAuto) ai.auto_close = false;

let route;
if (ai.requires_admin_decision) route = 'admin_decision';
else if (ai.category === 'software_install') route = 'software_install';
else if (ai.category === 'hardware_request') route = 'hardware_request';
else if (['hardware_issue', 'access_request', 'network', 'account'].includes(ai.category)) route = 'notify_it';
else route = 'software_help';

return [{ json: { ...ctx, ai, route } }];`);

  // route switch ---------------------------------------------------------
  const sw = f.add('Route Intent', 'n8n-nodes-base.switch', 3, X(13), {
    rules: {
      values: [
        { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' }, conditions: [{ id: 'r0', leftValue: '={{ $json.route }}', rightValue: 'software_install', operator: { type: 'string', operation: 'equals' } }], combinator: 'and' }, renameOutput: true, outputKey: 'software install' },
        { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' }, conditions: [{ id: 'r1', leftValue: '={{ $json.route }}', rightValue: 'software_help', operator: { type: 'string', operation: 'equals' } }], combinator: 'and' }, renameOutput: true, outputKey: 'software help' },
        { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' }, conditions: [{ id: 'r2', leftValue: '={{ $json.route }}', rightValue: 'notify_it', operator: { type: 'string', operation: 'equals' } }], combinator: 'and' }, renameOutput: true, outputKey: 'notify it' },
        { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' }, conditions: [{ id: 'r3', leftValue: '={{ $json.route }}', rightValue: 'hardware_request', operator: { type: 'string', operation: 'equals' } }], combinator: 'and' }, renameOutput: true, outputKey: 'hardware request' },
        { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' }, conditions: [{ id: 'r4', leftValue: '={{ $json.route }}', rightValue: 'admin_decision', operator: { type: 'string', operation: 'equals' } }], combinator: 'and' }, renameOutput: true, outputKey: 'admin decision' },
      ],
    },
    options: { fallbackOutput: 'none' },
  });

  // ---- branch: automated software install ------------------------------
  code(f, 'Prepare Install', X(14), `
const ctx = $json;
const ai = ctx.ai;
const entry = ai.catalog_match || null;
return [{ json: {
  ...ctx,
  install: entry ? { slug: entry.slug, name: entry.name } : null,
  install_prepared: Boolean(entry),
  outcome: { status: 'processing', user_message: '', resolution: '', it_message: null, it_priority: 'normal' },
} }];`);

  boolIf(f, 'If Auto Install Allowed', X(15), '={{ $json.install_prepared }}');

  f.add('Run Software Installer', 'n8n-nodes-base.executeCommand', 1, X(16), {
    command: '=sh /installers/software-install.sh {{ $json.install.slug }} {{ $json.ticket_id }} {{ $json.employee_email }}',
  });

  code(f, 'Install Result', X(17), `
const ctx = $('Parse AI Response').first().json;
const name = (ctx.ai.catalog_match && ctx.ai.catalog_match.name) || ctx.ai.requested_software || 'the software';
const stdout = String($json.stdout || '').slice(0, 2000);
const stderr = String($json.stderr || '').slice(0, 2000);
return [{ json: {
  ...ctx,
  install: { slug: ctx.ai.catalog_match ? ctx.ai.catalog_match.slug : null, name },
  install_result: { ok: Number($json.exitCode) === 0, exit_code: Number($json.exitCode), stdout, stderr },
} }];`);

  pg(f, 'Log Install', X(18), `
INSERT INTO software_installs (ticket_id, employee_email, software, status, exit_code, log, finished_at)
VALUES ($1,$2,$3,$4,$5,$6,now())
RETURNING id;`,
  '={{ [ $json.ticket_id, $json.employee_email, $json.install.name, $json.install_result.ok ? \'installed\' : \'failed\', $json.install_result.exit_code, ($json.install_result.stdout + "\\n" + $json.install_result.stderr).slice(0, 8000) ] }}');

  code(f, 'Finalize Install', X(19), `
const ctx = $('Install Result').first().json;
const ok = ctx.install_result.ok;
const name = ctx.install.name;
return [{ json: {
  ...ctx,
  outcome: {
    status: ok ? 'closed' : 'pending_it',
    user_message: ok
      ? name + ' is installed and ready to use. If you do not see it straight away, sign out and back in once.'
      : 'I could not finish installing ' + name + ' automatically. I have sent the error details to the IT team and they will complete it on your device.',
    resolution: (ok ? 'Automated install completed: ' : 'Automated install failed: ') + name,
    it_message: ok ? null : [
      'AUTOMATED INSTALL FAILED',
      'Software: ' + name,
      'Employee: ' + ctx.employee_email,
      'Exit code: ' + ctx.install_result.exit_code,
      'Output: ' + (ctx.install_result.stderr || ctx.install_result.stdout || 'none').slice(0, 700),
    ].join('\\n'),
    it_priority: ok ? 'normal' : 'high',
  },
} }];`);

  // ---- branch: needs admin approval (install / access / other) ---------
  code(f, 'Prepare Install Approval', [X(16), 320], `
const ctx = $json;
const ai = ctx.ai;
return [{ json: { ...ctx, approval: {
  kind: 'software_install',
  question: ai.admin_question || ('Approve installing ' + (ai.requested_software || 'the requested software') + ' for this employee?'),
  details: {
    employee: ctx.employee,
    requested_software: ai.requested_software,
    category: ai.category,
    severity: ai.severity,
    diagnosis: ai.diagnosis,
    recommendation: ai.resolution,
    confidence: ai.confidence,
  },
  requester: ctx.ticket.employee_email,
} } }];`);

  code(f, 'Prepare Admin Request', [X(14), 620], `
const ctx = $json;
const ai = ctx.ai;
return [{ json: { ...ctx, approval: {
  kind: ai.recommended_action || 'other',
  question: ai.admin_question || ('Approve the ' + ai.category.replace(/_/g, ' ') + ' request for this employee?'),
  details: {
    employee: ctx.employee,
    category: ai.category,
    severity: ai.severity,
    diagnosis: ai.diagnosis,
    recommendation: ai.resolution,
    it_actions: ai.it_actions,
    confidence: ai.confidence,
  },
  requester: ctx.ticket.employee_email,
} } }];`);

  pg(f, 'Create Approval', [X(17), 470], `
INSERT INTO approvals (ticket_id, kind, question, details, requester, resume_url)
VALUES ($1,$2,$3,$4::jsonb,$5,$6)
RETURNING id, kind, question;`,
  '={{ [ $json.ticket_id, $json.approval.kind, $json.approval.question, JSON.stringify($json.approval.details), $json.approval.requester, $execution.resumeUrl ] }}');

  code(f, 'Compose Approval Request', [X(18), 470], `
const appr = $json;
const ctx = $('Parse AI Response').first().json;
const base = $env.APPROVAL_BASE_URL;
const link = (d) => base + '?token=' + appr.id + '&decision=' + d;
const e = ctx.employee || {};
const t = ctx.ticket;
const lines = [
  'DECISION NEEDED (' + appr.kind.replace(/_/g, ' ') + ') - ticket ' + ctx.ticket_id,
  '',
  'Employee : ' + (t.employee_name || (e && e.name) || 'unknown') + ' <' + t.employee_email + '>',
  e && e.department ? 'Role     : ' + (e.role || '') + ' / ' + e.department + ' (manager ' + (e.manager_email || 'n/a') + ')' : null,
  e && e.device_model ? 'Device   : ' + e.device_model + ' | ' + (e.os_version || '') + ' | asset ' + (e.device_asset_tag || 'n/a') : 'Device   : not found in inventory sheet',
  'Subject  : ' + t.subject,
  'Request  : ' + ((ctx.ai && ctx.ai.requested_software) || (ctx.ai.hardware && ctx.ai.hardware.type) || appr.kind.replace(/_/g, ' ')),
  '',
  'AI diagnosis    : ' + (ctx.ai.diagnosis || 'n/a'),
  'AI recommendation: ' + (ctx.ai.resolution || 'n/a'),
  'Severity        : ' + ctx.ai.severity + '   confidence: ' + Math.round((ctx.ai.confidence || 0) * 100) + '%',
  '',
  'QUESTION: ' + appr.question,
  '',
  'APPROVE -> ' + link('approved'),
  'REJECT  -> ' + link('rejected'),
  '(links expire after 7 days)',
].filter((l) => l !== null);
return [{ json: {
  ...ctx,
  approval: { id: appr.id, kind: appr.kind, question: appr.question },
  it_message: lines.join('\\n'),
  it_priority: ctx.ai.severity === 'critical' ? 'critical' : 'high',
  outcome: { status: 'awaiting_admin', user_message: '', resolution: '', it_message: null, it_priority: 'high' },
} }];`);

  httpPost(f, 'Send Approval Request', [X(19), 470], {
    url: '={{ $env.HELPDESK_BASE_URL + "/internal-notes" }}',
    headers: HELP_HEADERS,
    body: '={{ JSON.stringify({ ticket_id: $json.ticket_id, body: $json.it_message, priority: $json.it_priority, kind: "approval_request" }) }}',
    onError: 'continueRegularOutput',
  });

  f.add('Wait For Decision', 'n8n-nodes-base.wait', 1.1, [X(20), 470], {
    resume: 'webhook',
    options: { httpMethod: 'GET', responseMode: 'onReceived' },
  }, { webhookId: randomUUID() });

  code(f, 'Apply Decision', [X(21), 470], `
const ctx = $('Compose Approval Request').first().json;
const p = Object.assign({}, $json.query || {}, ($json.body && typeof $json.body === 'object') ? $json.body : {});
const decision = String(p.decision || '').toLowerCase();
const decidedBy = String(p.decided_by || p.by || 'IT admin');
const approved = decision === 'approved';
const ai = ctx.ai;
const isInstall = approved && ai.recommended_action === 'install_software' && ai.catalog_match;
const name = (ai.catalog_match && ai.catalog_match.name) || ai.requested_software || 'the requested action';

const outcome = approved
  ? {
      status: isInstall ? 'processing' : 'closed',
      user_message: isInstall ? '' : 'Good news - the IT admin approved your request. The team is actioning it now and you will get an update on this ticket.',
      resolution: 'Approved by ' + decidedBy + ' (' + ctx.approval.question + ')',
      it_message: isInstall ? null : 'APPROVED by ' + decidedBy + ': ' + ctx.approval.question + '\\nAction for IT: ' + (ai.resolution || 'see ticket'),
      it_priority: 'normal',
    }
  : {
      status: 'pending_it',
      user_message: 'The IT admin reviewed your request and could not approve it as it stands. The reason is on your ticket and the team will follow up with alternatives.',
      resolution: 'Rejected by ' + decidedBy + ' (' + ctx.approval.question + ')',
      it_message: 'REJECTED by ' + decidedBy + ': ' + ctx.approval.question,
      it_priority: 'normal',
    };

return [{ json: {
  ...ctx,
  decision, decided_by: decidedBy, approved,
  install: isInstall ? { slug: ai.catalog_match.slug, name } : null,
  outcome,
} }];`);

  const decSwitch = f.add('Switch Decision', 'n8n-nodes-base.switch', 3, [X(22), 470], {
    rules: {
      values: [
        { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' }, conditions: [{ id: 'd0', leftValue: '={{ Boolean($json.install) }}', rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, renameOutput: true, outputKey: 'approved install' },
        { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' }, conditions: [{ id: 'd1', leftValue: '={{ $json.approved }}', rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, renameOutput: true, outputKey: 'approved other' },
      ],
    },
    options: { fallbackOutput: 'extra', renameFallbackOutput: 'rejected' },
  });

  // ---- branch: software help -------------------------------------------
  code(f, 'Prepare Help Reply', [X(14), 220], `
const ctx = $json;
const ai = ctx.ai;
const close = Boolean(ai.auto_close);
const e = ctx.employee || {};
return [{ json: {
  ...ctx,
  outcome: {
    status: close ? 'closed' : 'pending_it',
    user_message: ai.user_message || 'Please try those steps and reply here if the problem continues.',
    resolution: ai.resolution || ai.diagnosis || 'Guided troubleshooting provided.',
    it_message: close ? null : [
      'TICKET ' + ctx.ticket_id + ' - ' + ai.severity + ' software issue needs an IT look',
      'Employee: ' + (ctx.ticket.employee_name || e.name || 'unknown') + ' <' + ctx.ticket.employee_email + '>',
      e.device_model ? 'Device: ' + e.device_model + ' | ' + (e.os_version || '') : null,
      'Issue: ' + ctx.ticket.subject,
      'Diagnosis: ' + (ai.diagnosis || 'n/a'),
      'Steps already given to the user: ' + (ai.resolution || 'n/a'),
      ai.it_actions.length ? 'Follow-up: ' + ai.it_actions.join('; ') : null,
    ].filter(Boolean).join('\\n'),
    it_priority: ai.severity === 'high' || ai.severity === 'critical' ? 'high' : 'normal',
  },
} }];`);

  // ---- branch: notify IT (hardware issue / access / escalation) --------
  code(f, 'Prepare IT Report', [X(14), 780], `
const ctx = $json;
const ai = ctx.ai;
const e = ctx.employee || {};
const t = ctx.ticket;
const urgent = ai.severity === 'high' || ai.severity === 'critical';
const itMessage = [
  'TICKET ' + ctx.ticket_id + ' - ' + ai.category.replace(/_/g, ' ') + ' (' + ai.severity + ')',
  'Employee: ' + (t.employee_name || e.name || 'unknown') + ' <' + t.employee_email + '>',
  e.department ? 'Dept: ' + e.department + ' | manager: ' + (e.manager_email || 'n/a') + ' | tenure: ' + (e.tenure_days ?? 'n/a') + ' days' : null,
  e.device_model ? 'Device: ' + e.device_model + ' | ' + (e.os_version || '') + ' | RAM ' + (e.ram_gb || '?') + 'GB | asset ' + (e.device_asset_tag || 'n/a') : null,
  ctx.inventory_matched ? null : 'NOTE: employee not found in the IT inventory sheet - device details unknown.',
  'Subject: ' + t.subject,
  'Details: ' + String(t.description || '').slice(0, 600),
  '',
  'AI diagnosis: ' + (ai.diagnosis || 'n/a'),
  'AI recommendation: ' + (ai.resolution || 'n/a'),
  ai.it_actions.length ? 'Actions for IT: ' + ai.it_actions.join('; ') : null,
  'Confidence: ' + Math.round((ai.confidence || 0) * 100) + '%',
].filter((l) => l !== null);

return [{ json: {
  ...ctx,
  outcome: {
    status: 'pending_it',
    user_message: ai.user_message || 'I have shared this with the IT team and they will follow up on this ticket.',
    resolution: ai.resolution || ai.diagnosis || '',
    it_message: itMessage.join('\\n'),
    it_priority: urgent ? 'high' : 'normal',
  },
} }];`);

  // ---- branch: hardware request (workflow 3) ---------------------------
  httpPost(f, 'Call Asset Automation', [X(14), 1040], {
    url: '={{ $env.N8N_BASE_URL + "/webhook/it-helpdesk/asset-request" }}',
    headers: [{ name: 'content-type', value: 'application/json' }],
    body: '={{ JSON.stringify($json) }}',
    timeout: 20000,
    onError: 'continueRegularOutput',
  });

  code(f, 'Asset Decision Received', [X(15), 1040], `
const ctx = $('Parse AI Response').first().json;
const res = ($json.body && typeof $json.body === 'object') ? $json.body : ($json || {});
const failed = Boolean($json.error) || !res.decision;
return [{ json: {
  ...ctx,
  asset_result: res,
  outcome: failed
    ? {
        status: 'pending_it',
        user_message: 'I could not complete the asset check automatically, so I have passed your request to the IT team.',
        resolution: 'Asset automation call failed.',
        it_message: 'ASSET AUTOMATION FAILED for ticket ' + ctx.ticket_id + '\\n' + JSON.stringify($json).slice(0, 600),
        it_priority: 'high',
      }
    : {
        status: res.status || 'pending_it',
        user_message: res.user_message || 'I have raised this with the IT team and will update you here.',
        resolution: res.resolution || ('Asset request: ' + res.decision),
        it_message: res.it_message || null,
        it_priority: res.it_priority || 'normal',
      },
} }];`);

  // ---- branch: AI failed -----------------------------------------------
  code(f, 'AI Failure Fallback', [X(12), 520], `
const ctx = $('Build AI Request').first().json;
const err = $json.error || $json;
return [{ json: {
  ...ctx,
  ai: { category: 'other', severity: 'medium', confidence: 0, diagnosis: 'AI triage unavailable', resolution: '', user_message: '', auto_close: false, it_actions: ['manual triage'] },
  route: 'escalate',
  outcome: {
    status: 'pending_it',
    user_message: 'I have passed your ticket to the IT team for a manual review - you will hear from them here shortly.',
    resolution: 'AI triage unavailable.',
    it_message: 'AI TRIAGE FAILED (no model answered; primary ' + ($env.AI_BASE_URL || 'unset') + ') for ticket ' + ctx.ticket_id + '\\nEmployee: ' + ctx.ticket.employee_email + '\\nError: ' + JSON.stringify(err).slice(0, 600),
    it_priority: 'high',
  },
} }];`);

  // ---- shared tail ------------------------------------------------------
  const TAIL = 24;
  stringIf(f, 'If Needs IT Note', [TAIL * 260 + 440, 0], '={{ $json.it_report }}');

  stringIf(f, 'If Has Reply', [TAIL * 260 + 880, 0], '={{ $(\'Save Outcome\').first().json.last_reply }}');

  // ---- IT channel fan-out (Slack / Google Chat / Teams / email / generic) ----
  // Serves two callers: the terminal IT note, and an approval request. Every
  // channel is optional; with none configured it emits one skip item so the
  // branch ends without affecting the main flow.
  code(f, 'Build IT Alerts', [TAIL * 260 + 460, 420], `
const s = $json || {};
// $json here is the helpdesk note response, not the ticket: read the saved row
// (and fall back to the request context) for the authoritative fields.
const one = (name) => { try { return $(name).first().json || {}; } catch (e) { return {}; } };
const ctx = one('Build AI Request');
const tail = one('Save Outcome');
const t = ctx.ticket || {};
const cfg = ctx.config || {};
const ticket_id = s.ticket_id || s.id || tail.id || t.id || '';
const priority = String(tail.it_priority || s.it_priority || 'normal');
const status = String(tail.status || s.status || 'awaiting_admin');
const subject = String(s.subject || t.subject || ('Ticket ' + ticket_id));
const employee = String(s.employee_email || t.employee_email || '');
const who = String(t.employee_name || (ctx.employee && ctx.employee.name) || employee);
const report = String(tail.it_report || s.it_report || s.it_message || s.body || '').slice(0, 1500);
const company = (cfg.company && cfg.company.name) || 'IT';
const text = [
  '[' + priority.toUpperCase() + '] ' + status.replace(/_/g, ' ') + ' - ' + subject,
  company + ' helpdesk | ticket ' + ticket_id,
  'Employee: ' + who + (employee ? ' <' + employee + '>' : ''),
  '',
  report,
].join('\\n').trim();

const alerts = [];
const push = (channel, url, payload) => { if (url) alerts.push({ channel, url, payload }); };
// Slack and Google Chat incoming webhooks both accept {"text": "..."}.
push('slack', $env.IT_SLACK_WEBHOOK_URL, { text });
push('google_chat', $env.IT_GOOGLE_CHAT_WEBHOOK_URL, { text });
push('teams', $env.IT_TEAMS_WEBHOOK_URL, { text });
// Any HTTP email API (Resend, Mailgun, Postmark...): adjust the fields if yours differ.
push('email', $env.IT_EMAIL_WEBHOOK_URL, {
  from: $env.IT_EMAIL_FROM || 'helpdesk@example.com',
  to: String($env.IT_EMAIL_TO || '').split(',').map((v) => v.trim()).filter(Boolean),
  subject: '[' + priority.toUpperCase() + '] ' + subject + ' (' + ticket_id + ')',
  text,
});
// Escape hatch: your own gateway gets the full record as JSON.
push('generic', $env.IT_NOTIFY_WEBHOOK_URL, {
  kind: 'it_notification', ticket_id, status, priority, subject, employee, report,
  reply: String(tail.last_reply || s.last_reply || ''),
});

return alerts.length ? alerts.map((a) => ({ json: a })) : [{ json: { skip: true } }];`);

  boolIf(f, 'If Alerts Configured', [TAIL * 260 + 680, 420], '={{ !$json.skip }}');

  httpPost(f, 'Send IT Alerts', [TAIL * 260 + 900, 420], {
    url: '={{ $json.url }}',
    body: '={{ JSON.stringify($json.payload) }}',
    headers: [{ name: 'content-type', value: 'application/json' }],
    onError: 'continueRegularOutput',
    timeout: 15000,
  });

  httpPost(f, 'Send IT Internal Note', [TAIL * 260 + 220, 200], {
    url: '={{ $env.HELPDESK_BASE_URL + "/internal-notes" }}',
    headers: HELP_HEADERS,
    body: '={{ JSON.stringify({ ticket_id: $(\'Save Outcome\').first().json.id, body: $(\'Save Outcome\').first().json.it_report, priority: $(\'Save Outcome\').first().json.it_priority || "normal", kind: "ai_report" }) }}',
    onError: 'continueRegularOutput',
  });

  httpPost(f, 'Reply To Employee', [TAIL * 260 + 1100, 0], {
    url: '={{ $env.HELPDESK_BASE_URL + "/tickets/" + $(\'Save Outcome\').first().json.id + "/comments" }}',
    headers: HELP_HEADERS,
    body: '={{ JSON.stringify({ author: "ai-helpdesk", internal: false, body: $(\'Save Outcome\').first().json.last_reply }) }}',
    onError: 'continueRegularOutput',
  });

  stringIf(f, 'If Closed', [TAIL * 260 + 1320, 0], '={{ $(\'Save Outcome\').first().json.status }}', 'equals', 'closed');

  httpPost(f, 'Close Ticket In Helpdesk', [TAIL * 260 + 1540, -160], {
    url: '={{ $env.HELPDESK_BASE_URL + "/tickets/" + $(\'Save Outcome\').first().json.id + "/close" }}',
    headers: HELP_HEADERS,
    body: '={{ JSON.stringify({ resolution: $(\'Save Outcome\').first().json.resolution || "Resolved by AI helpdesk", closed_by: "ai-helpdesk" }) }}',
    onError: 'continueRegularOutput',
  });

  f.add('Kept Open For IT', NOOP, 1, [TAIL * 260 + 1540, 160]);

  code(f, 'Compose Outcome SQL', [TAIL * 260 + 1100, 0], `
const src = $json;
const o = src.outcome || {};
const ai = src.ai || {};
const q = (v) => (v === null || v === undefined ? 'NULL' : "'" + String(v).replace(/'/g, "''") + "'");
const status = o.status || 'pending_it';
const decision = JSON.stringify({ ai: ai, route: src.route || null, asset_result: src.asset_result || null });
const conf = Number(ai.confidence);
const sql = 'UPDATE tickets SET '
  + 'status = ' + q(status) + ', '
  + 'category = ' + q(ai.category || 'other') + ', '
  + 'severity = ' + q(ai.severity || 'medium') + ', '
  + 'confidence = ' + (Number.isFinite(conf) ? conf : 'NULL') + ', '
  + 'route = ' + q(src.route || null) + ', '
  + 'resolution = ' + q(o.resolution || '') + ', '
  + 'it_report = ' + q(o.it_message || null) + ', '
  + 'it_priority = ' + q(o.it_priority || 'normal') + ', '
  + 'last_reply = ' + q(o.user_message || '') + ', '
  + 'ai_decision = ' + q(decision) + '::jsonb, '
  + "closed_at = CASE WHEN " + q(status) + " = 'closed' THEN now() ELSE closed_at END, "
  + 'updated_at = now() '
  + 'WHERE id = ' + q(src.ticket_id)
  + ' RETURNING id, status, it_report, it_priority, last_reply, resolution;';
return [{ json: { sql, ticket_id: src.ticket_id } }];`);

  f.add('Save Outcome', 'n8n-nodes-base.postgres', 2.4, [TAIL * 260 + 1320, 0], {
    operation: 'executeQuery',
    query: '={{ $json.sql }}',
    options: {},
  }, { credentials: PG, alwaysOutputData: true });

  // wiring ---------------------------------------------------------------
  f.connect('Ticket Webhook', 'Normalize Ticket');
  f.connect('Normalize Ticket', 'If Ticket Valid');
  f.connect('If Ticket Valid', 'Reject Ticket', 1);
  f.connect('If Ticket Valid', 'Accept Ticket', 0);
  f.connect('Accept Ticket', 'Upsert Ticket');
  f.connect('Upsert Ticket', 'Read IT Config');
  f.connect('Read IT Config', 'Extract Config Text');
  f.connect('Extract Config Text', 'Parse Config');
  f.connect('Parse Config', 'Read Inventory Sheet');
  f.connect('Read Inventory Sheet', 'Parse Inventory Sheet');
  f.connect('Parse Inventory Sheet', 'Build AI Request');
  f.connect('Build AI Request', 'AI Triage');
  f.connect('AI Triage', 'Parse AI Response', 0);
  f.connect('AI Triage', 'If Fallback Configured', 1);
  f.connect('If Fallback Configured', 'AI Fallback', 0);
  f.connect('If Fallback Configured', 'AI Failure Fallback', 1);
  f.connect('AI Fallback', 'Parse AI Response', 0);
  f.connect('AI Fallback', 'AI Failure Fallback', 1);
  f.connect('Parse AI Response', 'Route Intent');

  f.connect('Route Intent', 'Prepare Install', 0);
  f.connect('Route Intent', 'Prepare Help Reply', 1);
  f.connect('Route Intent', 'Prepare IT Report', 2);
  f.connect('Route Intent', 'Call Asset Automation', 3);
  f.connect('Route Intent', 'Prepare Admin Request', 4);

  f.connect('Prepare Install', 'If Auto Install Allowed');
  f.connect('If Auto Install Allowed', 'Run Software Installer', 0);
  f.connect('If Auto Install Allowed', 'Prepare Install Approval', 1);
  f.connect('Run Software Installer', 'Install Result');
  f.connect('Install Result', 'Log Install');
  f.connect('Log Install', 'Finalize Install');
  f.connect('Finalize Install', 'Compose Outcome SQL');

  f.connect('Prepare Install Approval', 'Create Approval');
  f.connect('Prepare Admin Request', 'Create Approval');
  f.connect('Create Approval', 'Compose Approval Request');
  f.connect('Compose Approval Request', 'Send Approval Request');
  f.connect('Send Approval Request', 'Wait For Decision');
  f.connect('Wait For Decision', 'Apply Decision');
  f.connect('Apply Decision', 'Switch Decision');
  f.connect('Switch Decision', 'Run Software Installer', 0);
  f.connect('Switch Decision', 'Compose Outcome SQL', 1);
  f.connect('Switch Decision', 'Compose Outcome SQL', 2);

  f.connect('Prepare Help Reply', 'Compose Outcome SQL');
  f.connect('Prepare IT Report', 'Compose Outcome SQL');
  f.connect('Asset Decision Received', 'Compose Outcome SQL');
  f.connect('Call Asset Automation', 'Asset Decision Received');
  f.connect('AI Failure Fallback', 'Compose Outcome SQL');

  f.connect('Compose Outcome SQL', 'Save Outcome');
  f.connect('Save Outcome', 'If Needs IT Note');
  f.connect('If Needs IT Note', 'Send IT Internal Note', 0);
  f.connect('If Needs IT Note', 'If Has Reply', 1);
  f.connect('Send IT Internal Note', 'If Has Reply');
  f.connect('Send IT Internal Note', 'Build IT Alerts');
  f.connect('Send Approval Request', 'Build IT Alerts');
  f.connect('Build IT Alerts', 'If Alerts Configured');
  f.connect('If Alerts Configured', 'Send IT Alerts', 0);
  f.connect('If Has Reply', 'Reply To Employee', 0);
  f.connect('If Has Reply', 'If Closed', 1);
  f.connect('Reply To Employee', 'If Closed');
  f.connect('If Closed', 'Close Ticket In Helpdesk', 0);
  f.connect('If Closed', 'Kept Open For IT', 1);
  // Close Ticket In Helpdesk and Kept Open For IT are terminal: the ticket
  // record is already saved and the helpdesk has the outcome.

  return f;
}

// ===========================================================================
// WORKFLOW 2 — approval link handler (yes/no from IT admin)
// ===========================================================================
function approvals() {
  const f = new Flow('IT Helpdesk - Admin Approval', 'ithdApprovalWf01');
  const X = (i) => [i * 260, 0];

  webhookNode(f, 'Approval Webhook', X(0), 'GET', 'it-helpdesk/approval');

  code(f, 'Parse Approval Request', X(1), `
const q = $json.query || {};
const b = ($json.body && typeof $json.body === 'object') ? $json.body : {};
const token = String(q.token || b.token || '').trim();
const decision = String(q.decision || b.decision || '').toLowerCase().trim();
const decided_by = String(q.by || b.by || b.decided_by || 'it-admin').trim();
const valid = token.length >= 8 && ['approved', 'rejected'].includes(decision);
return [{ json: { token, decision, decided_by, valid } }];`);

  boolIf(f, 'If Request Valid', X(2), '={{ $json.valid }}');

  pg(f, 'Lookup Approval', X(3), `
SELECT id, ticket_id, kind, question, status, resume_url,
       (status = 'pending' AND expires_at > now()) AS usable
FROM approvals WHERE id::text = $1 LIMIT 1;`,
  '={{ [ $json.token ] }}', { alwaysOutputData: true });

  boolIf(f, 'If Still Pending', X(4), '={{ $json.usable }}');

  pg(f, 'Record Decision', X(5), `
UPDATE approvals
SET status = $2, decided_by = $3, decided_at = now()
WHERE id::text = $1 AND status = 'pending'
RETURNING id, ticket_id, status, resume_url, question;`,
  '={{ [ $(\'Parse Approval Request\').first().json.token, $(\'Parse Approval Request\').first().json.decision, $(\'Parse Approval Request\').first().json.decided_by ] }}');

  f.add('Wake Paused Workflow', 'n8n-nodes-base.httpRequest', 4.2, X(6), {
    method: 'GET',
    url: '={{ $json.resume_url }}',
    sendQuery: true,
    queryParameters: {
      parameters: [
        { name: 'decision', value: "={{ $('Parse Approval Request').first().json.decision }}" },
        { name: 'decided_by', value: "={{ $('Parse Approval Request').first().json.decided_by }}" },
        { name: 'approval_id', value: '={{ $json.id }}' },
        { name: 'approval_status', value: '={{ $json.status }}' },
      ],
    },
    options: { timeout: 20000 },
  }, { onError: 'continueRegularOutput' });

  code(f, 'Build Result Page', X(7), `
const p = $('Parse Approval Request').first().json;
const rec = $('Record Decision').first().json || {};
const ok = p.decision === 'approved';
const color = ok ? '#4ade80' : '#f87171';
const title = ok ? 'Approved' : 'Rejected';
const ticket = rec.ticket_id || 'unknown';
const html = '<!doctype html><html><head><meta charset="utf-8"><title>Decision recorded</title>'
  + '<style>body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}'
  + '.card{background:#1e293b;padding:40px 48px;border-radius:14px;max-width:520px;box-shadow:0 20px 50px rgba(0,0,0,.4)}'
  + 'h1{margin:0 0 12px;font-size:22px;color:' + color + '}p{line-height:1.6;color:#cbd5e1}code{background:#0f172a;padding:2px 6px;border-radius:4px}'
  + '</style></head><body><div class="card"><h1>' + title + '</h1>'
  + '<p>Decision <strong>' + p.decision + '</strong> recorded for ticket <code>' + ticket + '</code>.</p>'
  + '<p>The AI helpdesk has been notified and will continue the ticket automatically. You can close this window.</p>'
  + '</div></body></html>';
return [{ json: { html } }];`);

  respondHtml(f, 'Result Page', X(8), '={{ $json.html }}');

  respondHtml(f, 'Invalid Page', [X(7), 220], '=<!doctype html><html><head><meta charset="utf-8"><title>Link not usable</title><style>body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}.card{background:#1e293b;padding:40px 48px;border-radius:14px;max-width:520px}h1{margin:0 0 12px;font-size:22px;color:#fbbf24}p{line-height:1.6;color:#cbd5e1}</style></head><body><div class="card"><h1>This link is not usable</h1><p>The decision link is invalid, was already used, or has expired (links are valid for 7 days).</p><p>Open the ticket in the helpdesk to see the current state.</p></div></body></html>', 410);

  f.connect('Approval Webhook', 'Parse Approval Request');
  f.connect('Parse Approval Request', 'If Request Valid');
  f.connect('If Request Valid', 'Lookup Approval', 0);
  f.connect('If Request Valid', 'Invalid Page', 1);
  f.connect('Lookup Approval', 'If Still Pending');
  f.connect('If Still Pending', 'Record Decision', 0);
  f.connect('If Still Pending', 'Invalid Page', 1);
  f.connect('Record Decision', 'Wake Paused Workflow');
  f.connect('Wake Paused Workflow', 'Build Result Page');
  f.connect('Build Result Page', 'Result Page');

  return f;
}

// ===========================================================================
// WORKFLOW 3 — asset request (phase 2)
// ===========================================================================
function assets() {
  const f = new Flow('IT Helpdesk - Asset Request', 'ithdAssetWf00001');
  const X = (i) => [i * 260, 0];

  webhookNode(f, 'Asset Request Webhook', X(0), 'POST', 'it-helpdesk/asset-request');

  code(f, 'Parse Asset Request', X(1), `
const b = ($json.body && typeof $json.body === 'object') ? $json.body : ($json || {});
const ai = b.ai || {};
const ticket = b.ticket || {};
const employee = b.employee || null;
const config = b.config || {};
const hw = ai.hardware || {};
return [{ json: {
  ticket_id: b.ticket_id || ticket.ticket_id,
  ticket,
  employee,
  employee_email: (employee && employee.email) || ticket.employee_email || '',
  ai,
  config,
  reason: String(hw.reason || ai.diagnosis || ''),
  requested_type: String(hw.type || '').toLowerCase().trim(),
} }];`);

  pg(f, 'Check Availability', X(2), `
SELECT id, asset_tag, type, model, serial, purchase_date
FROM assets
WHERE type = $1 AND status = 'available'
ORDER BY purchase_date NULLS LAST
LIMIT 5;`,
  '={{ [ $json.requested_type ] }}', { alwaysOutputData: true });

  pg(f, 'Check Current Holding', X(3), `
SELECT count(*)::int AS held
FROM assets
WHERE lower(assigned_to) = lower($1) AND type = $2;`,
  '={{ [ $(\'Parse Asset Request\').first().json.employee_email, $(\'Parse Asset Request\').first().json.requested_type ] }}', { alwaysOutputData: true });

  code(f, 'Evaluate Guidelines', X(4), `
const req = $('Parse Asset Request').first().json;
const g = req.config.asset_guidelines || {};
const emp = req.employee || null;
const ai = req.ai || {};
const type = req.requested_type;
const available = $('Check Availability').all().map((i) => i.json).filter((a) => a && a.asset_tag);
const held = Number(($('Check Current Holding').first().json || {}).held || 0);
const reasons = [];

const allowed = g.allowed_types || [];
if (!type) reasons.push('I could not tell which type of hardware you need. Please mention it (laptop, monitor, headset, dock, keyboard, mouse or phone) and why.');
else if (allowed.length && !allowed.includes(type)) reasons.push(type + ' is not available through self-service hardware requests.');

if (!emp) reasons.push('Your employee record is not in the IT inventory sheet yet, so eligibility cannot be verified. IT will add it and re-check.');

let tenure = null;
if (emp) {
  tenure = Number(emp.tenure_days);
  const minTenure = Number(g.min_tenure_days ?? 0);
  if (Number.isFinite(tenure) && minTenure > 0 && tenure < minTenure) {
    reasons.push('Minimum tenure for a hardware allocation is ' + minTenure + ' days and you have ' + tenure + '.');
  }
  const status = String(emp.employment_status || '').toLowerCase();
  if ((g.blocked_statuses || []).map((s) => String(s).toLowerCase()).includes(status)) {
    reasons.push('Employment status "' + emp.employment_status + '" is not eligible for asset allocation.');
  }
  const dept = String(emp.department || '').toLowerCase();
  if ((g.blocked_departments || []).map((s) => String(s).toLowerCase()).includes(dept)) {
    reasons.push('Department ' + emp.department + ' is not eligible for this allocation.');
  }
  if (emp.device_asset_tag && type === 'laptop') {
    reasons.push('You already have a laptop assigned (' + emp.device_asset_tag + ' ' + (emp.device_model || '') + '). A replacement needs an IT assessment, not a new allocation.');
  }
}

const minReason = Number(g.min_reason_chars ?? 0);
if (String(req.reason).trim().length < minReason) reasons.push('Please explain why you need it in a bit more detail (at least ' + minReason + ' characters).');
if (g.require_ai_reason_ok && ai.reason_ok === false) reasons.push('The reason given is not specific enough for an asset request.');

const limit = Number(g.max_assets_of_same_type ?? 0);
if (limit > 0 && held >= limit) reasons.push('You already hold ' + held + ' ' + type + '(s); the limit is ' + limit + '.');

const eligible = reasons.length === 0;
const needsAdmin = (g.require_admin_approval_types || []).includes(type) || eligible;

return [{ json: {
  ...req,
  available,
  held,
  tenure_days: tenure,
  guidelines: g,
  reasons,
  eligible,
  needs_admin_approval: eligible && needsAdmin,
} }];`);

  boolIf(f, 'If Eligible', X(5), '={{ $json.eligible }}');

  respondJson(f, 'Respond Not Eligible', [X(5), 260],
    '={{ JSON.stringify({ decision: "not_eligible", status: "closed", user_message: "I checked the IT asset guidelines for this request and it cannot be raised automatically yet:\\n\\n- " + $json.reasons.join("\\n- ") + "\\n\\nIf you think this is wrong, reply here and the IT team will review it.", resolution: "Asset request blocked by guidelines: " + $json.reasons.join("; ") }) }}');

  boolIf(f, 'If Asset In Stock', X(6), '={{ $json.available.length > 0 }}');

  code(f, 'Prepare Procurement Note', [X(6), 300], `
const r = $json;
const emp = r.employee || {};
const body = [
  'HARDWARE NOT IN STOCK - ticket ' + r.ticket_id,
  'Employee: ' + (emp.name || r.employee_email) + ' <' + r.employee_email + '>',
  'Dept: ' + (emp.department || 'n/a') + ' | role: ' + (emp.role || 'n/a'),
  'Requested: ' + r.requested_type,
  'Reason: ' + r.reason,
  'Guidelines: passed (eligible).',
  '',
  'Action: procure a ' + r.requested_type + ' or offer an alternative. The employee has been told there is no stock.',
].join('\\n');
return [{ json: { ...r, it_message: body } }];`);

  httpPost(f, 'Notify IT Procurement', [X(7), 300], {
    url: '={{ $env.HELPDESK_BASE_URL + "/internal-notes" }}',
    headers: HELP_HEADERS,
    body: '={{ JSON.stringify({ ticket_id: $json.ticket_id, body: $json.it_message, priority: "high", kind: "procurement" }) }}',
    onError: 'continueRegularOutput',
  });

  respondJson(f, 'Respond Out Of Stock', [X(8), 300],
    '={{ JSON.stringify({ decision: "out_of_stock", status: "pending_it", user_message: "You qualify for a " + $("Prepare Procurement Note").first().json.requested_type + ", but we currently have none in stock. I have asked IT to procure one and they will update you on this ticket.", resolution: "Eligible, no stock. Procurement requested.", it_message: null }) }}');

  code(f, 'Prepare Asset Approval', X(7), `
const r = $json;
const emp = r.employee || {};
const pick = r.available[0];
const body = [
  'HARDWARE ALLOCATION - approval needed - ticket ' + r.ticket_id,
  'Employee: ' + (emp.name || r.employee_email) + ' <' + r.employee_email + '>',
  'Dept: ' + (emp.department || 'n/a') + ' | role: ' + (emp.role || 'n/a') + ' | tenure: ' + (r.tenure_days ?? 'n/a') + ' days',
  'Current device: ' + (emp.device_asset_tag || 'none') + ' ' + (emp.device_model || ''),
  '',
  'Requested: ' + r.requested_type,
  'Reason: ' + r.reason,
  'Guidelines: PASSED (' + (r.guidelines.notes || 'see data/it-config.json') + ')',
  'Available asset proposed: ' + pick.asset_tag + ' ' + (pick.model || ''),
  '',
  'QUESTION: Approve assigning asset ' + pick.asset_tag + ' (' + (pick.model || r.requested_type) + ') to this employee?',
].join('\\n');
return [{ json: { ...r, proposed_asset: pick, it_message: body, request_question: 'Approve assigning asset ' + pick.asset_tag + ' (' + (pick.model || r.requested_type) + ') to ' + (emp.name || r.employee_email) + '?' } }];`);

  pg(f, 'Create Asset Approval', X(8), `
INSERT INTO approvals (ticket_id, kind, question, details, requester, resume_url)
VALUES ($1,'hardware_assign',$2,$3::jsonb,$4,$5)
RETURNING id, question;`,
  '={{ [ $json.ticket_id, $json.request_question, JSON.stringify({ proposed_asset: $json.proposed_asset, requested_type: $json.requested_type, reason: $json.reason, guidelines: $json.guidelines, employee: $json.employee }), $json.employee_email, $execution.resumeUrl ] }}');

  code(f, 'Compose Asset Approval Note', X(9), `
const a = $json;
const r = $('Prepare Asset Approval').first().json;
const base = $env.APPROVAL_BASE_URL;
const link = (d) => base + '?token=' + a.id + '&decision=' + d;
const body = r.it_message + '\\n\\nAPPROVE -> ' + link('approved') + '\\nREJECT  -> ' + link('rejected') + '\\n(links expire after 7 days)';
return [{ json: {
  ...r,
  approval_id: a.id,
  it_message: body,
  user_message: 'Good news: a ' + r.requested_type + ' is available and you meet the asset guidelines. I have sent the allocation request to the IT admin for approval and will update you here as soon as they respond.',
} }];`);

  httpPost(f, 'Send Asset Approval Note', [X(10), 0], {
    url: '={{ $env.HELPDESK_BASE_URL + "/internal-notes" }}',
    headers: HELP_HEADERS,
    body: '={{ JSON.stringify({ ticket_id: $json.ticket_id, body: $json.it_message, priority: "high", kind: "asset_approval" }) }}',
    onError: 'continueRegularOutput',
  });

  respondJson(f, 'Respond Pending Approval', [X(11), 0],
    '={{ JSON.stringify({ decision: "eligible_pending_admin", status: "awaiting_admin", user_message: $json.user_message, resolution: "Asset allocation awaiting IT admin approval.", approval_id: $json.approval_id }) }}');

  f.add('Wait Asset Decision', 'n8n-nodes-base.wait', 1.1, [X(12), 0], {
    resume: 'webhook',
    options: { httpMethod: 'GET', responseMode: 'onReceived' },
  }, { webhookId: randomUUID() });

  code(f, 'Apply Asset Decision', [X(13), 0], `
const ctx = $('Compose Asset Approval Note').first().json;
const p = Object.assign({}, $json.query || {}, ($json.body && typeof $json.body === 'object') ? $json.body : {});
const decision = String(p.decision || '').toLowerCase();
return [{ json: { ...ctx, decision, approved: decision === 'approved', decided_by: String(p.decided_by || 'IT admin'), approval_id: p.approval_id || ctx.approval_id } }];`);

  boolIf(f, 'If Asset Approved', X(14), '={{ $json.approved }}');

  pg(f, 'Assign Asset', [X(15), -140], `
WITH picked AS (
  UPDATE assets
  SET status = 'assigned', assigned_to = $1, assigned_at = now()
  WHERE id = (
    SELECT id FROM assets
    WHERE type = $2 AND status = 'available'
    ORDER BY purchase_date NULLS LAST
    LIMIT 1
  )
  RETURNING id, asset_tag, type, model
), ins AS (
  INSERT INTO asset_assignments (asset_id, asset_tag, employee_email, ticket_id, reason, approved_by, approval_id, assigned_at)
  SELECT picked.id, picked.asset_tag, $1, $3, $4, $5, $6, now()
  FROM picked
  RETURNING id
)
SELECT picked.asset_tag, picked.type, picked.model FROM picked;`,
  '={{ [ $(\'Apply Asset Decision\').first().json.employee_email, $(\'Apply Asset Decision\').first().json.requested_type, $(\'Apply Asset Decision\').first().json.ticket_id, $(\'Apply Asset Decision\').first().json.reason, $(\'Apply Asset Decision\').first().json.decided_by, $(\'Apply Asset Decision\').first().json.approval_id ] }}');

  code(f, 'Compose Assigned Message', [X(16), -140], `
const a = $('Assign Asset').first().json;
const ctx = $('Apply Asset Decision').first().json;
const emp = ctx.employee || {};
const text = [
  'Approved. Asset ' + a.asset_tag + ' (' + (a.model || a.type) + ') is now assigned to you.',
  'Please collect it from the IT desk (' + ((ctx.config.company && ctx.config.company.it_department) || 'IT') + ') with your employee ID.',
  'If you need it delivered to ' + (emp.location || 'your location') + ', reply here and IT will arrange it.',
].join(' ');
return [{ json: { ticket_id: ctx.ticket_id, status: 'closed', text, resolution: 'Asset ' + a.asset_tag + ' assigned, approved by ' + ctx.decided_by + '.' } }];`);

  httpPost(f, 'Tell Employee Assigned', [X(17), -140], {
    url: '={{ $env.HELPDESK_BASE_URL + "/tickets/" + $json.ticket_id + "/comments" }}',
    headers: HELP_HEADERS,
    body: '={{ JSON.stringify({ author: "ai-helpdesk", internal: false, body: $json.text }) }}',
    onError: 'continueRegularOutput',
  });

  httpPost(f, 'Close Assigned Ticket', [X(18), -140], {
    url: '={{ $env.HELPDESK_BASE_URL + "/tickets/" + $(\'Compose Assigned Message\').first().json.ticket_id + "/close" }}',
    headers: HELP_HEADERS,
    body: '={{ JSON.stringify({ resolution: $(\'Compose Assigned Message\').first().json.resolution, closed_by: "ai-helpdesk" }) }}',
    onError: 'continueRegularOutput',
  });

  pg(f, 'Save Asset Ticket Outcome', [X(19), -140], `
UPDATE tickets SET
  status = $1, resolution = $2, category = 'hardware_request',
  it_report = $3, updated_at = now(),
  closed_at = CASE WHEN $1 = 'closed' THEN now() ELSE closed_at END
WHERE id = $4
RETURNING id, status;`,
  '={{ [ $(\'Compose Assigned Message\').first().json.status, $(\'Compose Assigned Message\').first().json.resolution, $(\'Compose Asset Approval Note\').first().json.it_message, $(\'Compose Assigned Message\').first().json.ticket_id ] }}');

  code(f, 'Compose Declined Message', [X(15), 160], `
const ctx = $('Apply Asset Decision').first().json;
const text = 'The IT admin reviewed the hardware request and did not approve the allocation right now. Your ticket has been updated with their note, and the team will follow up with alternatives.';
return [{ json: { ticket_id: ctx.ticket_id, status: 'pending_it', text, resolution: 'Asset allocation rejected by ' + ctx.decided_by + '.' } }];`);

  httpPost(f, 'Tell Employee Declined', [X(16), 160], {
    url: '={{ $env.HELPDESK_BASE_URL + "/tickets/" + $json.ticket_id + "/comments" }}',
    headers: HELP_HEADERS,
    body: '={{ JSON.stringify({ author: "ai-helpdesk", internal: false, body: $json.text }) }}',
    onError: 'continueRegularOutput',
  });

  pg(f, 'Save Declined Outcome', [X(17), 160], `
UPDATE tickets SET status = $1, resolution = $2, updated_at = now()
WHERE id = $3
RETURNING id, status;`,
  '={{ [ $json.status, $json.resolution, $json.ticket_id ] }}');

  f.connect('Asset Request Webhook', 'Parse Asset Request');
  f.connect('Parse Asset Request', 'Check Availability');
  f.connect('Check Availability', 'Check Current Holding');
  f.connect('Check Current Holding', 'Evaluate Guidelines');
  f.connect('Evaluate Guidelines', 'If Eligible');
  f.connect('If Eligible', 'Respond Not Eligible', 1);
  f.connect('If Eligible', 'If Asset In Stock', 0);
  f.connect('If Asset In Stock', 'Prepare Procurement Note', 1);
  f.connect('Prepare Procurement Note', 'Notify IT Procurement');
  f.connect('Notify IT Procurement', 'Respond Out Of Stock');
  f.connect('If Asset In Stock', 'Prepare Asset Approval', 0);
  f.connect('Prepare Asset Approval', 'Create Asset Approval');
  f.connect('Create Asset Approval', 'Compose Asset Approval Note');
  f.connect('Compose Asset Approval Note', 'Send Asset Approval Note');
  f.connect('Send Asset Approval Note', 'Respond Pending Approval');
  f.connect('Respond Pending Approval', 'Wait Asset Decision');
  f.connect('Wait Asset Decision', 'Apply Asset Decision');
  f.connect('Apply Asset Decision', 'If Asset Approved');
  f.connect('If Asset Approved', 'Assign Asset', 0);
  f.connect('Assign Asset', 'Compose Assigned Message');
  f.connect('Compose Assigned Message', 'Tell Employee Assigned');
  f.connect('Tell Employee Assigned', 'Close Assigned Ticket');
  f.connect('Close Assigned Ticket', 'Save Asset Ticket Outcome');
  f.connect('If Asset Approved', 'Compose Declined Message', 1);
  f.connect('Compose Declined Message', 'Tell Employee Declined');
  f.connect('Tell Employee Declined', 'Save Declined Outcome');

  return f;
}

triage().save();
approvals().save();
assets().save();
console.log('done — import with: docker compose exec n8n n8n import:workflow --separate --input=/workflows');
