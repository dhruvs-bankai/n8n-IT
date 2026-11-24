// Mock OpenAI-compatible endpoint so the automation can be exercised without
// an API key. Swap AI_BASE_URL/AI_MODEL/AI_API_KEY to use a real model; the
// n8n workflow only speaks /chat/completions with a JSON-only contract.
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT || 8080);

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

const base = (over = {}) => ({
  category: 'other',
  severity: 'low',
  confidence: 0.8,
  diagnosis: '',
  resolution: '',
  user_message: '',
  requires_admin_decision: false,
  admin_question: null,
  recommended_action: null,
  requested_software: null,
  hardware: null,
  reason_ok: true,
  auto_close: true,
  it_actions: [],
  ...over,
});

// Very small keyword router that mimics a competent triage model.
function decide(userText) {
  const t = userText.toLowerCase();

  const wantsInstall = /(install|set ?up|need|download)\b/.test(t) && /(software|app|chrome|firefox|vscode|vs code|zoom|slack|7zip|7-zip|notepad|acrobat|figma|autocad|tool)/.test(t);
  const paid = ['acrobat', 'figma', 'autocad', 'adobe'].find((k) => t.includes(k));
  const free = ['chrome', 'firefox', 'vscode', 'vs code', 'zoom', 'slack', '7zip', '7-zip', 'notepad'].find((k) => t.includes(k));

  // hardware allocation first, but never when this is a software install ask
  const hardwareAsk = /(monitor|headset|dock|keyboard|mouse|phone|second screen|external screen|new laptop|replacement laptop|loaner)/.test(t)
    || (/hardware/.test(t) && /(need|request|require|replace|faulty|broken)/.test(t));
  if (!wantsInstall && hardwareAsk && /(need|request|require|replace|new|broken|not working|faulty|additional)/.test(t)) {
    const type = ['monitor', 'headset', 'dock', 'keyboard', 'mouse', 'laptop', 'phone'].find((k) => t.includes(k)) || 'laptop';
    return base({
      category: 'hardware_request',
      severity: 'low',
      confidence: 0.86,
      diagnosis: `Employee requested additional ${type}.`,
      resolution: 'Eligibility must be checked against IT asset guidelines.',
      user_message: `Thanks for the request. I am checking whether a spare ${type} is available and whether the asset guidelines allow the allocation.`,
      recommended_action: 'check_asset_availability',
      hardware: { type, model: null, reason: userText.slice(0, 400) },
      reason_ok: userText.length > 30,
      auto_close: false,
      it_actions: ['asset eligibility check'],
    });
  }

  if (wantsInstall && paid) {
    const name = paid === 'adobe' ? 'Adobe Acrobat Pro' : paid.charAt(0).toUpperCase() + paid.slice(1);
    return base({
      category: 'software_install',
      severity: 'low',
      confidence: 0.83,
      diagnosis: `Requested paid software: ${name}.`,
      resolution: `A paid license is needed; IT admin must approve the seat before installation.`,
      user_message: `I can install ${name}, but it needs a paid license, so I have asked the IT admin to approve it. I will continue as soon as I have an answer.`,
      requires_admin_decision: true,
      admin_question: `Approve a paid ${name} license and installation for this employee?`,
      recommended_action: 'install_software',
      requested_software: name,
      auto_close: false,
      it_actions: ['license check', 'admin approval'],
    });
  }

  if (wantsInstall) {
    const name = {
      chrome: 'Google Chrome',
      firefox: 'Mozilla Firefox',
      vscode: 'Visual Studio Code',
      'vs code': 'Visual Studio Code',
      zoom: 'Zoom Workplace',
      slack: 'Slack',
      '7zip': '7-Zip',
      '7-zip': '7-Zip',
      notepad: 'Notepad++',
    }[free || 'chrome'];
    return base({
      category: 'software_install',
      severity: 'low',
      confidence: 0.9,
      diagnosis: `${name} is missing on the employee device; request matches the approved software catalog.`,
      resolution: `Install ${name} silently and confirm to the employee.`,
      user_message: `I have started installing ${name} on your system. It usually takes about a minute — I will confirm here as soon as it is done.`,
      recommended_action: 'install_software',
      requested_software: name,
      auto_close: true,
      it_actions: ['software install'],
    });
  }

  if (/(outlook|excel|word|teams|browser|app|software|error|crash|slow|won'?t open|not working|freez|hang|update)/.test(t)) {
    return base({
      category: 'software_issue',
      severity: 'medium',
      confidence: 0.78,
      diagnosis: 'Application-level fault, most likely a stale profile cache or a pending update.',
      resolution: 'Clear the application cache, restart the app, and apply pending updates.',
      user_message:
        'Here is what usually fixes this: 1) close the app completely, 2) press Windows key + R, type %temp% and delete the files, 3) reopen the app and let it update. If it still fails after that, reply here and I will take it to the IT team with the details.',
      auto_close: false,
      it_actions: ['send troubleshooting steps'],
    });
  }

  if (/(laptop|fan|hot|overheat|battery|screen|keyboard|hardware|blue screen|bsod|noise)/.test(t)) {
    return base({
      category: 'hardware_issue',
      severity: 'high',
      confidence: 0.81,
      diagnosis: 'Likely cooling/thermal fault (dust build-up or failing fan) on the assigned device.',
      resolution: 'Physical inspection required; do not keep using the device under heavy load.',
      user_message:
        'That sounds like a cooling problem that needs a physical check. Please save your work and switch the laptop off for now. I have sent the full details to the IT team and they will contact you to arrange a check or a loaner device.',
      auto_close: false,
      it_actions: ['create IT hardware report', 'recommend loaner device'],
    });
  }

  if (/(vpn|network|wifi|internet|access|permission|account|password|login|shared drive)/.test(t)) {
    return base({
      category: 'access_request',
      severity: 'medium',
      confidence: 0.72,
      diagnosis: 'Access/connectivity request that depends on user permissions.',
      resolution: 'IT admin must confirm the entitlement before any access is granted.',
      user_message: 'I have passed this to the IT admin with your details, because access changes need their approval. You will hear back on this ticket.',
      requires_admin_decision: true,
      admin_question: 'Approve the requested access for this employee?',
      recommended_action: 'grant_access',
      auto_close: false,
      it_actions: ['verify entitlement', 'admin approval'],
    });
  }

  return base({
    category: 'other',
    severity: 'medium',
    confidence: 0.4,
    diagnosis: 'Not enough detail to classify safely.',
    resolution: 'Human triage required.',
    user_message: 'I have shared this with the IT team — they will pick it up shortly.',
    auto_close: false,
    it_actions: ['human triage'],
  });
}

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/health')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }
  if (req.method === 'POST' && req.url.includes('/chat/completions')) {
    const body = await readBody(req);
    const messages = body.messages || [];
    const rawUser = messages.filter((m) => m.role === 'user').pop()?.content || '';
    // The workflow sends ticket + employee + catalog as one JSON blob.
    // Classify from the ticket text only, never from the catalog keywords.
    let user = rawUser;
    try {
      const parsed = JSON.parse(rawUser);
      if (parsed && parsed.ticket) {
        user = `${parsed.ticket.subject || ''} ${parsed.ticket.description || ''}`;
      }
    } catch {
      /* plain text prompt */
    }
    const result = decide(user);
    const content = JSON.stringify(result);
    const payload = {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body.model || 'mock-it-agent',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 500, completion_tokens: 200, total_tokens: 700 },
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(payload));
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, '0.0.0.0', () => console.log(`mock-llm listening on :${PORT}`));
