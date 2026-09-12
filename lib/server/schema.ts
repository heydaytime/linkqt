export const LINKQT_SCHEMA_SQL = `
create table if not exists builder_projects (
  id text primary key,
  user_id text not null,
  title text not null,
  origin text not null check (origin in ('ai', 'manual')),
  created_at text not null,
  updated_at text not null
);
create index if not exists builder_projects_user_updated_idx on builder_projects(user_id, updated_at desc);

create table if not exists builder_runs (
  id text primary key,
  project_id text not null references builder_projects(id) on delete cascade,
  user_id text not null,
  parent_run_id text references builder_runs(id) on delete restrict,
  kind text not null check (kind in ('ai', 'manual')),
  status text not null default 'completed' check (status in ('pending', 'completed', 'failed')),
  is_seed integer not null default 0 check (is_seed in (0, 1)),
  title text,
  prompt text,
  document text not null,
  links_json text not null default '[]',
  created_at text not null
);
create index if not exists builder_runs_project_created_idx on builder_runs(project_id, created_at asc);
create index if not exists builder_runs_parent_idx on builder_runs(parent_run_id);

create table if not exists deployments (
  id text primary key,
  user_id text not null,
  site_key text not null,
  project_id text not null,
  run_id text not null,
  document text not null,
  deployed_at text not null
);
create index if not exists deployments_deployed_idx on deployments(deployed_at desc);
create index if not exists deployments_site_deployed_idx on deployments(site_key, deployed_at desc);

create table if not exists deployment_targets (
  site_key text primary key,
  user_id text not null,
  created_at text not null
);

create table if not exists user_profiles (
  user_id text primary key,
  email text,
  subdomain text unique,
  created_at text not null,
  updated_at text not null
);
create unique index if not exists user_profiles_subdomain_idx on user_profiles(subdomain) where subdomain is not null;

create table if not exists builder_run_tool_events (
  id text primary key,
  run_id text not null references builder_runs(id) on delete cascade,
  project_id text not null references builder_projects(id) on delete cascade,
  user_id text not null,
  sequence integer not null,
  event_type text not null,
  tool_name text,
  status text not null,
  message text not null,
  args_json text not null default '{}',
  result_json text not null default '{}',
  document_hash text,
  duration_ms integer,
  created_at text not null
);
create index if not exists builder_run_tool_events_run_sequence_idx on builder_run_tool_events(run_id, sequence asc);

create table if not exists ai_usage (
  user_id text not null,
  day text not null,
  count integer not null default 0,
  primary key (user_id, day)
);

create table if not exists idempotency_keys (
  user_id text not null,
  route text not null,
  key text not null,
  body_hash text not null,
  status_code integer not null,
  response_json text not null,
  created_at text not null,
  primary key (user_id, route, key)
);
create index if not exists idempotency_keys_created_idx on idempotency_keys(created_at);
`;
