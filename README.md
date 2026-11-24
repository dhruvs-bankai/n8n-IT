# IT Helpdesk Automation (n8n)

Fully automated IT helpdesk for the IT department, built on **n8n + Postgres**, running in Docker.

An employee raises a ticket in the company portal → the helpdesk API calls an n8n webhook → the AI
reads the ticket, looks the employee up in the **IT inventory Excel sheet**, decides what to do, acts
(installs software, answers the user, reports to IT, or asks the IT admin for a yes/no decision), and
closes the ticket. Phase 2 adds **asset management**: the AI checks real stock, applies the IT admin's
asset guidelines, and only then asks for approval to allocate hardware — and records the assignment.

```
Portal ──▶ Helpdesk API ──▶ n8n webhook
                              │
                    ┌─────────┴──────────┐
                    ▼                    ▼
          IT inventory sheet      LLM (OpenAI-compatible)
          data/it-inventory.xlsx  AI_BASE_URL / AI_MODEL
                    │
                    ▼
        ┌───────────────────────────────────────────────┐
        │  Workflow 1: AI Triage                        │
        │  install software / answer user / report IT /  │
        │  ask admin (yes/no) / hand to asset workflow   │
        └───────────────┬───────────────────────────────┘
                        │  approval links
                        ▼
        Workflow 2: Admin Approval  ──▶ resumes paused execution
                        ▲
        Workflow 3: Asset Request (phase 2) ──▶ assigns asset, updates DB
```

## What it does per ticket

| AI intent | What the automation does |
|---|---|
| `software_install` (catalog, free) | Runs the installer in the background, confirms to the user, closes the ticket. |
| `software_install` (paid / not in catalog) | Writes an approval record, messages IT admin with **APPROVE / REJECT** links, pauses, then installs or informs the user. |
| `software_issue` | Sends the user OS-specific steps; closes if confident, otherwise leaves it open for IT with a written report. |
| `hardware_issue` | Never closes itself: sends IT a structured report (employee, device, asset tag, diagnosis, recommendation) and tells the user what to do meanwhile. |
| `hardware_request` | Calls the **asset workflow**: checks stock in the DB, applies `asset_guidelines`, asks admin only if every guideline passes, then assigns the asset and records it. |
| low confidence / AI error | Escalates to IT with the raw context; ticket stays open. |

**Policy is enforced in code, not by the model:** the catalog allowlist, paid-license rules, severity
and confidence thresholds and asset guidelines are all evaluated deterministically in Code nodes. The
LLM only classifies and writes text. It never invents a device, a license, or stock.

## Quick start

Requirements: Docker Desktop, Node 20+. Ports 5678 (n8n), 8080 (mock helpdesk), 8081 (mock LLM).

```bash
bash scripts/bootstrap.sh
```

That will:

1. create `.env` (with a generated `N8N_ENCRYPTION_KEY`),
2. start Postgres, n8n, and the two local stand-in services,
3. import the Postgres credential and the three workflows, activate them,
4. create the n8n owner account (`N8N_OWNER_EMAIL` / `N8N_OWNER_PASSWORD`).

Open http://localhost:5678 and log in.

### Fire a test ticket

```bash
node scripts/send-ticket.mjs sara.khan "Need VS Code installed"
node scripts/send-ticket.mjs ali.raza "Laptop fan very loud, machine hot" "Since yesterday the fan runs at full speed and it shuts down."
node scripts/send-ticket.mjs bilal.ahmed "Need a second monitor" "I work on spreadsheets all day and need a second monitor for comparing reports."
```

Watch the result in the mock helpdesk (the API stand-in):

```bash
curl -H "x-api-key: dev-helpdesk-key" http://localhost:8080/tickets
curl -H "x-api-key: dev-helpdesk-key" http://localhost:8080/notes      # what IT was told
```

Approvals print their links into `/notes`. Open one and the paused execution resumes by itself.

## Connecting the real systems

Everything external is env-driven — no workflow editing needed.

| Env | Meaning |
|---|---|
| `HELPDESK_BASE_URL`, `HELPDESK_API_KEY` | The real helpdesk API base URL and its token. Adjust the HTTP nodes in **workflow 1** if its routes or auth header differ from the mock contract. |
| `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL` | Any OpenAI-compatible endpoint (`https://api.openai.com/v1`, Azure OpenAI, Ollama, vLLM…). |
| `AI_FALLBACK_BASE_URL`, `AI_FALLBACK_API_KEY`, `AI_FALLBACK_MODEL` | Optional second opinion. **Empty by default**: a failed primary escalates straight to a human. Set it only if you want an automatic retry on another provider. |
| `N8N_BASE_URL` | Public n8n URL; used by workflow 1 to call workflow 3 and by approval links. |
| `IT_SLACK_WEBHOOK_URL` | Slack Incoming Webhook — posts `{ text }` for every ticket needing a human and every approval request. |
| `IT_GOOGLE_CHAT_WEBHOOK_URL` | Google Chat space webhook — posts `{ text }`. |
| `IT_TEAMS_WEBHOOK_URL` | MS Teams incoming webhook — posts `{ text }`. |
| `IT_EMAIL_WEBHOOK_URL`, `IT_EMAIL_TO`, `IT_EMAIL_FROM` | Any HTTP email API (Resend, Mailgun, Postmark…) — posts `{ from, to[], subject, text }`. |
| `IT_NOTIFY_WEBHOOK_URL` | Your own gateway — posts the whole record as JSON. |
| `APPROVAL_BASE_URL` | Public base for approval links. |

### Where each credential goes

Everything lives in `.env` (gitignored, never committed). After changing it, recreate the affected
service — **`docker compose restart` does not re-read `.env`**:

| What you have | Put it in `.env` as | Then run |
|---|---|---|
| Claude subscription token (`claude setup-token`) | `CLAUDE_CODE_OAUTH_TOKEN=<token>` | `docker compose up -d --force-recreate claude-bridge n8n` |
| Claude API key instead of the subscription | `ANTHROPIC_API_KEY=sk-ant-...` (wins over the token, bills per token) | same |
| Helpdesk dashboard API base URL | `HELPDESK_BASE_URL=https://your-helpdesk/api` | `docker compose up -d --force-recreate n8n` |
| Helpdesk API token | `HELPDESK_API_KEY=<token>` | same |
| Slack channel webhook | `IT_SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...` | same |
| Google Chat space webhook | `IT_GOOGLE_CHAT_WEBHOOK_URL=https://chat.googleapis.com/v1/spaces/...` | same |
| Teams channel webhook | `IT_TEAMS_WEBHOOK_URL=https://...webhook.office.com/...` | same |
| Email API endpoint + recipients | `IT_EMAIL_WEBHOOK_URL=...`, `IT_EMAIL_TO`, `IT_EMAIL_FROM` | same |

Two things that bite when swapping the real helpdesk in:

- n8n sends the token as the header `x-api-key`. If your helpdesk expects `Authorization: Bearer`,
  change `HELP_HEADERS` in `scripts/build-workflows.mjs` (the only place), then re-run
  `node scripts/build-workflows.mjs` and re-import.
- If its routes differ, the HTTP URLs in workflow 1 are the only place to edit — they are all built from
  `HELPDESK_BASE_URL`.

Channels are independent: one, several or none. With none set, IT still gets every note inside the
helpdesk (`GET /notes` on the mock) and nothing else happens.

### Optional: a Claude subscription instead of an API key

A Claude Pro/Max subscription does **not** include API access, and Anthropic does not allow an
application to hold Claude.ai credentials or talk to the API as Claude Code. What it does allow is an
end user signing in to the **unmodified Claude Code CLI** with their own plan. `claude-bridge/` is
exactly that: a small service that runs the real `claude -p` binary and exposes the same
`/chat/completions` contract the workflow already uses, so n8n never holds a Claude credential.

```bash
# on a machine with a browser, once (prints a one-year token)
claude setup-token
```

Then in `.env`:

```
CLAUDE_CODE_OAUTH_TOKEN=<token from setup-token>
AI_BASE_URL=http://claude-bridge:8080/v1
AI_API_KEY=unused          # the bridge only checks that a bearer token is present
```

```bash
docker compose up -d --force-recreate n8n claude-bridge
```

`docker compose logs claude-bridge` shows `mode=subscription` when it is wired up. Set
`ANTHROPIC_API_KEY` in `.env` instead to bill the API from the same bridge — in `-p` mode an API key
always outranks the subscription token.

**If the credential stops working** (Anthropic blocks the path, the plan limit is hit, or the token
expires after a year) nothing breaks:

1. `AI Triage` gets one attempt. No retries — a rate-limited subscription must not be hammered.
2. `AI_FALLBACK_BASE_URL` is empty by default, so a dead credential **escalates immediately**: the ticket
   goes `pending_it`, the employee is told a human will pick it up, and IT gets an `AI TRIAGE FAILED` note
   naming the provider and the error. Nothing is lost, and no stand-in model answers in Claude's place.
3. If you *do* set `AI_FALLBACK_BASE_URL`, that provider gets the second attempt first; if it also fails,
   the same escalation happens.
4. Recovery is one env change (`AI_BASE_URL` → an API key provider or a local model) plus
   `docker compose up -d --force-recreate n8n`. The workflows are untouched.

The bridge also serializes calls (one at a time) and disables all tools (`--tools ""`, `--max-turns 1`) so
a triage call can only classify — it can never run a command on the machine. No port is published for it.

### Helpdesk API contract expected

See `mock-helpdesk/server.mjs`. In short:

- `POST {HELPDESK_BASE_URL}/internal-notes` → `{ ticket_id, body, priority, kind }`
- `POST {HELPDESK_BASE_URL}/tickets/{id}/comments` → `{ author, internal, body }`
- `POST {HELPDESK_BASE_URL}/tickets/{id}/close` → `{ resolution, closed_by }`
- inbound webhook `POST /webhook/it-helpdesk/ticket` with
  `{ ticket_id, requester_email, requester_name, subject, description, priority }`

## Data & configuration

- `data/it-inventory.xlsx` — employee ↔ system sheet the AI reads (`scripts/make-inventory.py` regenerates it).
  Columns: employee_id, name, email, department, role, start_date, manager_email, location,
  employment_status, device_asset_tag, device_model, os_version, ram_gb, storage_gb,
  installed_software, vpn_access, last_backup, notes.
- `data/it-config.json` — **owned by the IT admin**: software catalog (allowlist, licenses, auto-install
  flags), AI policy thresholds, and `asset_guidelines` (min tenure, reason length, per-type limits,
  blocked departments/statuses, which types need admin approval).
- `db/init/01-schema.sql` — `tickets`, `approvals`, `notifications`, `software_installs`, `assets`,
  `asset_assignments` + seeded assets.
- `installers/software-install.sh` — the install runner. Runs in **simulate** mode today; replace the
  simulate block with winget/brew/apt or your RMM/Intune/SSH runner (`installation_targets` in the config
  shows the intended commands).

## Safety rules baked in

- Installer slugs are allowlisted twice: in the workflow catalog check and again inside the script.
- The AI can never grant access, allocate hardware, or install a paid/non-catalog package without a
  yes/no from a human.
- Hardware requests must pass **every** asset guideline before the admin is even asked.
- Critical severity and low confidence always route to a human.
- Tickets that IT must act on stay `pending_it` — the AI never closes them.

## Workflows

| File | Trigger | Purpose |
|---|---|---|
| `workflows/it-helpdesk-ai-triage.json` | `POST /webhook/it-helpdesk/ticket` | Main pipeline. |
| `workflows/it-helpdesk-admin-approval.json` | `GET /webhook/it-helpdesk/approval?token=…&decision=…` | Records the admin's yes/no and wakes the paused run. |
| `workflows/it-helpdesk-asset-request.json` | `POST /webhook/it-helpdesk/asset-request` | Phase 2 asset availability, guidelines, approval, assignment. |

The JSON is **generated** from `scripts/build-workflows.mjs`. Edit that file and run
`node scripts/build-workflows.mjs`; then re-import. Editing JSON by hand gets overwritten.

```bash
bash scripts/reset.sh   # optional: drop volumes and rebuild from scratch
```

## Repo layout

```
docker-compose.yml          stack: postgres, n8n, mock-helpdesk, mock-llm
.env.example                every knob
db/init/01-schema.sql       schema + seeded assets
data/it-inventory.xlsx      employee/system sheet (AI context)
data/it-config.json         catalog, AI policy, asset guidelines
installers/software-install.sh
mock-helpdesk/server.mjs    stand-in for the portal API
mock-llm/server.mjs         stand-in OpenAI-compatible model
scripts/build-workflows.mjs workflow source of truth
scripts/bootstrap.sh        one-command setup
scripts/send-ticket.mjs     raise a test ticket
scripts/make-inventory.py   regenerate the xlsx
workflows/*.json            generated, imported by n8n
runtime/logs/               install logs (gitignored)
```

## Verified locally

Checked end to end against n8n 2.49.5 + Postgres 17 with the bundled mock services:

| Raised ticket | Outcome |
|---|---|
| "Need VS Code installed" (catalog, free) | Installer ran, install logged, employee told, ticket closed. |
| "Need Adobe Acrobat Pro" (paid) | Approval request with links → **approve** → installer ran → closed. |
| Same, **reject** | Decision recorded, employee told, ticket left `pending_it`. |
| "Laptop fan loud / hot" | `pending_it`, high priority, IT report with device + asset tag + recommendation, employee reply. |
| "Need a second monitor" (eligible, in stock) | Guidelines passed → admin approve → asset `IT-MN-2001` assigned, `asset_assignments` row, ticket closed. |
| "Need a monitor" from a probation employee | Refused by guidelines (tenure + probation), reasons sent to employee, admin never bothered. |
| "Need a company phone" (eligible, no stock) | Employee informed, procurement note queued for IT, ticket `pending_it`. |
| "Outlook keeps crashing" | Troubleshooting steps sent, ticket left open for IT. |
| Any ticket, primary = bridge with **no credential**, fallback unset | `pending_it`, route `escalate`, employee told a human will follow up, IT note `AI TRIAGE FAILED (no model answered; primary http://claude-bridge:8080/v1)`. |
| Same, with an explicit `AI_FALLBACK_BASE_URL` | Second provider answered, ticket closed normally. |

## n8n 2.x gotchas this repo already handles

- `executeCommand` is disabled by default → `NODES_EXCLUDE=[]`.
- File nodes are blocked outside an allowlist → `N8N_RESTRICT_FILE_ACCESS_TO=/data;/runtime;/installers`.
- A Webhook node without a `webhookId` registers under `{workflowId}/{nodeName}/...` → every webhook node has one.
- `update:workflow` is gone → `publish:workflow --id=…`, and a running n8n needs a restart before new published versions serve webhooks (`bootstrap.sh` does both).
- The image is Alpine (no bash) → the installer is POSIX `sh`.
- `Extract from File` uses operation `xlsx` (not `spreadsheet`); an unknown operation silently emits zero items.
- `$('Node').first()` returns nothing when that node branched → the tail reads a single unbranched node (`Save Outcome`).

## Phase 2 notes / next steps

- Point `assets` at the real asset-management system (replace the two Postgres nodes in workflow 3 with
  HTTP calls to its API) — the assignment record is already written in `asset_assignments`.
- Add SSO/portal authentication on the inbound webhook and verify the caller is the helpdesk API.
- Rotate `N8N_ENCRYPTION_KEY` only together with re-importing credentials, and never commit `.env`.
