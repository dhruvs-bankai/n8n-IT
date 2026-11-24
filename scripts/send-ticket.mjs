// Raise a test ticket end to end:
//   1. creates the ticket in the helpdesk (mock API) so it exists there,
//   2. POSTs it to the n8n triage webhook, like the portal/helpdesk would.
//
//   node scripts/send-ticket.mjs sara.khan "Need VS Code installed"
//   node scripts/send-ticket.mjs ali.raza "Fan is loud" "Dell fan spins at full speed..."
const [, , emailArg, subjectArg, descriptionArg] = process.argv;

// accept "sara.khan" or a full address
const email = emailArg
  ? (emailArg.includes('@') ? emailArg : `${emailArg}@example.com`)
  : 'sara.khan@example.com';
const subject = subjectArg || 'Need Visual Studio Code installed';
const description =
  descriptionArg ||
  'I joined the backend team this month and need VS Code on my laptop to open the project. Please install it.';

const ticketId = `TCK-${Date.now().toString().slice(-6)}`;
const apiKey = process.env.HELPDESK_API_KEY || 'dev-helpdesk-key';
const helpdesk = process.env.HELPDESK_PUBLIC_URL || 'http://localhost:8080';
const webhook = process.env.N8N_WEBHOOK_URL || 'http://localhost:5678/webhook/it-helpdesk/ticket';

const payload = {
  ticket_id: ticketId,
  requester_email: email,
  requester_name: '',
  subject,
  description,
  priority: 'normal',
};

// 1. ticket exists in the helpdesk
const created = await fetch(`${helpdesk}/tickets`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
  body: JSON.stringify({ id: ticketId, subject, description, requester_email: email }),
});
console.log(`helpdesk ticket ${ticketId}: ${created.status}`);

// 2. the helpdesk triggers the automation
const res = await fetch(webhook + '?source=cli', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
  body: JSON.stringify(payload),
});
console.log(`webhook: ${res.status} ${await res.text()}`);
console.log(`inspect: curl -H "x-api-key: ${apiKey}" ${helpdesk}/tickets`);
