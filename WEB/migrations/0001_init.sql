CREATE TABLE user (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    email_verified INTEGER NOT NULL DEFAULT 0,
    image TEXT,
    role TEXT NOT NULL DEFAULT 'USER',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE session (
    id TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL,
    token TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE
);

CREATE TABLE account (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    issuer TEXT NOT NULL DEFAULT '',
    user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    access_token TEXT,
    refresh_token TEXT,
    id_token TEXT,
    access_token_expires_at INTEGER,
    refresh_token_expires_at INTEGER,
    scope TEXT,
    password TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE verification (
    id TEXT PRIMARY KEY,
    identifier TEXT NOT NULL,
    value TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    prefix TEXT NOT NULL UNIQUE,
    current_ticket_sequence INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);

CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    ticket_id TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'TODO',
    assignee_id TEXT REFERENCES user(id) ON DELETE SET NULL,
    created_by TEXT REFERENCES user(id) ON DELETE SET NULL,
    position REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX idx_tasks_project_status ON tasks(project_id, status);

CREATE TABLE project_members (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'MEMBER',
    PRIMARY KEY (project_id, user_id)
);

CREATE TABLE invitations (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    invited_role TEXT NOT NULL DEFAULT 'MEMBER',
    expires_at INTEGER NOT NULL,
    accepted_at INTEGER,
    created_by TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
);

CREATE INDEX idx_invitations_email ON invitations(email);

CREATE TABLE activity_log (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    actor_id TEXT REFERENCES user(id) ON DELETE SET NULL,
    event_type TEXT NOT NULL,
    old_status TEXT,
    new_status TEXT,
    created_at INTEGER NOT NULL
);

CREATE INDEX idx_activity_created ON activity_log(created_at);

CREATE TABLE job_runs (
    job_name TEXT NOT NULL,
    period_key TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (job_name, period_key)
);

CREATE TABLE security_findings (
    id TEXT PRIMARY KEY,
    cve TEXT NOT NULL,
    package_name TEXT NOT NULL,
    severity TEXT NOT NULL,
    fixed_version TEXT,
    reported_at INTEGER NOT NULL,
    resolved_at INTEGER
);

CREATE UNIQUE INDEX uq_security_finding ON security_findings(cve, package_name);
