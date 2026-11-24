// Mock IT helpdesk API.
// This is the contract the n8n workflows speak to. When the real helpdesk API
// arrives, point HELPDESK_BASE_URL at it and keep these routes/semantics (or
// adjust the HTTP nodes in workflow 01 — they are the only place that talks to it).
//
//   GET  /health
//   GET  /tickets                    list tickets
//   GET  /tickets/:id                one ticket
//   POST /tickets                    create a ticket
//   PATCH /tickets/:id               { status, priority, category }
//   POST /tickets/:id/comments       { body, author, internal }
//   POST /tickets/:id/close          { resolution }
//   POST /internal-notes             { ticket_id, body, priority, kind }
//   POST /notify                     receives a channel payload and records it
//   GET  /notify                     what IT's Slack/Chat/email webhooks got
//   GET  /notes                      everything IT was told (for inspection)
//   GET  /events                     audit trail for demos
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT || 8080);
const API_KEY = process.env.HELPDESK_API_KEY || 'dev-helpdesk-key';

const db = {
  tickets: [
    {
      id: 'TCK-1001',
      subject: 'Laptop fan is very loud and machine gets hot',
      description:
        'Since yesterday my Dell Latitude fan runs at full speed and the bottom of the laptop is very hot. It shuts down sometimes.',
      requester_email: 'ali.raza@example.com',
      requester_name: 'Ali Raza',
      status: 'open',
      priority: 'normal',
      category: 'hardware',
      created_at: '2026-11-24T08:10:00Z',
    },
    {
      id: 'TCK-1002',
      subject: 'Need Visual Studio Code installed',
      description: 'I joined the backend team and need VS Code on my laptop to open the project.',
      requester_email: 'sara.khan@example.com',
      requester_name: 'Sara Khan',
      status: 'open',
      priority: 'low',
      category: 'software',
      created_at: '2026-11-24T08:40:00Z',
    },
  ],
  notes: [],
  events: [],
};

let seq = 1002;
const now = () => new Date().toISOString();
const find = (id) => db.tickets.find((t) => t.id === id);
const event = (type, data) => db.events.push({ at: now(), type, ...data });

function send(res, status, body, headers = {}) {
  const payload = JSON.stringify(body ?? {});
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1_000_000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname.replace(/\/$/, '') || '/';
  const key = req.headers['x-api-key'];
  // /notify stands in for an external channel webhook, which has no API key.
  const authOk = path === '/health' || path === '/notify' || key === API_KEY;

  if (!authOk) return send(res, 401, { error: 'invalid api key' });

  if (req.method === 'GET' && path === '/health') {
    return send(res, 200, { ok: true, tickets: db.tickets.length, service: 'mock-helpdesk' });
  }
  if (req.method === 'GET' && path === '/tickets') return send(res, 200, { data: db.tickets });
  if (req.method === 'GET' && path === '/notes') return send(res, 200, { data: db.notes });
  if (req.method === 'GET' && path === '/events') return send(res, 200, { data: db.events });

  if (req.method === 'POST' && path === '/notify') {
    const body = await readBody(req);
    db.channels = db.channels || [];
    db.channels.push({ at: now(), body });
    event('channel.notified', { fields: Object.keys(body || {}).join(',') });
    return send(res, 200, { ok: true });
  }
  if (req.method === 'GET' && path === '/notify') return send(res, 200, { data: db.channels || [] });

  if (req.method === 'POST' && path === '/tickets') {
    const body = await readBody(req);
    const ticket = {
      id: body.id || `TCK-${++seq}`,
      subject: body.subject || '(no subject)',
      description: body.description || '',
      requester_email: body.requester_email || body.employee_email,
      requester_name: body.requester_name || body.employee_name || '',
      status: 'open',
      priority: body.priority || 'normal',
      category: body.category || 'other',
      created_at: now(),
    };
    db.tickets.push(ticket);
    event('ticket.created', { ticket_id: ticket.id });
    return send(res, 201, ticket);
  }

  const commentMatch = path.match(/^\/tickets\/([^/]+)\/comments$/);
  if (req.method === 'POST' && commentMatch) {
    const ticket = find(commentMatch[1]);
    if (!ticket) return send(res, 404, { error: 'ticket not found' });
    const body = await readBody(req);
    const comment = {
      id: `CMT-${db.notes.length + 1}`,
      ticket_id: ticket.id,
      author: body.author || 'ai-helpdesk',
      internal: Boolean(body.internal),
      body: String(body.body || ''),
      at: now(),
    };
    ticket.comments = ticket.comments || [];
    ticket.comments.push(comment);
    if (comment.internal) db.notes.push({ kind: 'comment', ...comment });
    event('ticket.comment', { ticket_id: ticket.id, internal: comment.internal });
    return send(res, 201, comment);
  }

  const closeMatch = path.match(/^\/tickets\/([^/]+)\/close$/);
  if (req.method === 'POST' && closeMatch) {
    const ticket = find(closeMatch[1]);
    if (!ticket) return send(res, 404, { error: 'ticket not found' });
    const body = await readBody(req);
    ticket.status = 'closed';
    ticket.resolution = body.resolution || ticket.resolution || '';
    ticket.closed_at = now();
    event('ticket.closed', { ticket_id: ticket.id });
    return send(res, 200, ticket);
  }

  const ticketMatch = path.match(/^\/tickets\/([^/]+)$/);
  if (ticketMatch && req.method === 'GET') {
    const ticket = find(ticketMatch[1]);
    return ticket ? send(res, 200, ticket) : send(res, 404, { error: 'ticket not found' });
  }
  if (ticketMatch && req.method === 'PATCH') {
    const ticket = find(ticketMatch[1]);
    if (!ticket) return send(res, 404, { error: 'ticket not found' });
    const body = await readBody(req);
    Object.assign(ticket, {
      ...(body.status ? { status: body.status } : {}),
      ...(body.priority ? { priority: body.priority } : {}),
      ...(body.category ? { category: body.category } : {}),
      updated_at: now(),
    });
    event('ticket.updated', { ticket_id: ticket.id, status: ticket.status });
    return send(res, 200, ticket);
  }

  if (req.method === 'POST' && path === '/internal-notes') {
    const body = await readBody(req);
    const note = {
      kind: 'internal-note',
      id: `NOTE-${db.notes.length + 1}`,
      ticket_id: body.ticket_id || null,
      priority: body.priority || 'normal',
      body: String(body.body || body.text || ''),
      at: now(),
    };
    db.notes.push(note);
    event('it.notified', { ticket_id: note.ticket_id, priority: note.priority });
    return send(res, 201, note);
  }

  return send(res, 404, { error: 'not found', path });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`mock-helpdesk listening on :${PORT} (api key required except /health)`);
});
