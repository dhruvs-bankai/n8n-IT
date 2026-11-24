-- IT Helpdesk automation schema.
-- Runs automatically the first time the postgres volume is created.

CREATE TABLE IF NOT EXISTS tickets (
  id                TEXT PRIMARY KEY,
  external_id       TEXT,
  employee_email    TEXT NOT NULL,
  employee_name     TEXT,
  subject           TEXT,
  description       TEXT,
  category          TEXT,
  severity          TEXT,
  confidence        NUMERIC(4,3),
  route             TEXT,
  status            TEXT NOT NULL DEFAULT 'received',
  -- received | processing | closed | pending_it | awaiting_admin | failed
  resolution        TEXT,
  it_report         TEXT,
  it_priority       TEXT DEFAULT 'normal',
  last_reply        TEXT,
  ai_decision       JSONB,
  source            TEXT DEFAULT 'helpdesk',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS tickets_status_idx ON tickets (status);
CREATE INDEX IF NOT EXISTS tickets_employee_idx ON tickets (employee_email);

-- Yes/no decisions requested from the IT admin. `resume_url` is the paused
-- n8n execution's webhook, so the approval workflow can wake it back up.
CREATE TABLE IF NOT EXISTS approvals (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id     TEXT REFERENCES tickets(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,             -- software_install | hardware_assign | access | other
  question      TEXT NOT NULL,
  details       JSONB NOT NULL DEFAULT '{}'::jsonb,
  requester     TEXT,
  resume_url    TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected | expired
  decided_by    TEXT,
  decided_at    TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT now() + interval '7 days',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS approvals_pending_idx ON approvals (status, expires_at);

-- Every message sent to the IT team (report, escalation, procurement note).
CREATE TABLE IF NOT EXISTS notifications (
  id          BIGSERIAL PRIMARY KEY,
  ticket_id   TEXT,
  kind        TEXT NOT NULL,
  priority    TEXT DEFAULT 'normal',
  body        TEXT NOT NULL,
  payload     JSONB DEFAULT '{}'::jsonb,
  delivered   BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Software install runs triggered by the AI.
CREATE TABLE IF NOT EXISTS software_installs (
  id              BIGSERIAL PRIMARY KEY,
  ticket_id       TEXT,
  employee_email  TEXT,
  software        TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'requested', -- requested | running | installed | failed | denied
  exit_code       INT,
  log             TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ
);

-- ---------- Phase 2: asset management ----------
CREATE TABLE IF NOT EXISTS assets (
  id            BIGSERIAL PRIMARY KEY,
  asset_tag     TEXT UNIQUE NOT NULL,
  type          TEXT NOT NULL,          -- laptop | monitor | headset | dock | phone | keyboard | mouse
  model         TEXT,
  serial        TEXT,
  status        TEXT NOT NULL DEFAULT 'available', -- available | assigned | repair | retired
  assigned_to   TEXT,
  assigned_at   TIMESTAMPTZ,
  purchase_date DATE,
  warranty_until DATE,
  notes         TEXT
);

CREATE TABLE IF NOT EXISTS asset_assignments (
  id              BIGSERIAL PRIMARY KEY,
  asset_id        BIGINT REFERENCES assets(id),
  asset_tag       TEXT,
  employee_email  TEXT NOT NULL,
  ticket_id       TEXT,
  reason          TEXT,
  approved_by     TEXT,
  approval_id     UUID REFERENCES approvals(id),
  assigned_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  returned_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS assets_available_idx ON assets (type, status);

INSERT INTO assets (asset_tag, type, model, serial, status, purchase_date, warranty_until)
VALUES
  ('IT-LT-1001', 'laptop',  'Dell Latitude 5440', 'DL5440-88213', 'available', '2025-02-10', '2028-02-10'),
  ('IT-LT-1002', 'laptop',  'Dell Latitude 5440', 'DL5440-88214', 'available', '2025-02-10', '2028-02-10'),
  ('IT-LT-1003', 'laptop',  'Lenovo ThinkPad T14', 'LN-T14-55120', 'assigned',  '2024-11-01', '2027-11-01'),
  ('IT-MN-2001', 'monitor', 'Dell P2422H 24"',     'DLP2422-1190',  'available', '2024-06-15', '2027-06-15'),
  ('IT-MN-2002', 'monitor', 'Dell P2422H 24"',     'DLP2422-1191',  'available', '2024-06-15', '2027-06-15'),
  ('IT-HS-3001', 'headset', 'Jabra Evolve2 40',    'JB-EV2-7781',   'available', '2025-01-20', '2027-01-20'),
  ('IT-DK-4001', 'dock',    'Dell WD19S',          'WD19S-33421',   'available', '2024-09-05', '2027-09-05'),
  ('IT-KB-5001', 'keyboard','Logitech K380',       'LG-K380-9122',  'available', '2025-03-01', '2027-03-01')
ON CONFLICT (asset_tag) DO NOTHING;

UPDATE assets SET assigned_to = 'sara.khan@example.com', assigned_at = '2025-01-05'
WHERE asset_tag = 'IT-LT-1003' AND assigned_to IS NULL;
