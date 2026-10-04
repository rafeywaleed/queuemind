-- QueueMind schema. Run once in the Supabase SQL editor.
-- All writes go through the server (service role). The browser gets read-only access for Realtime.

create extension if not exists pgcrypto;

create table if not exists clinics (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  timezone text not null default 'Asia/Karachi',
  grace_minutes int not null default 10,
  no_show_minutes int not null default 20,
  max_bumps int not null default 2,
  free_follow_up_days int not null default 5,
  delay_notify_threshold_min int not null default 15,
  created_at timestamptz not null default now()
);

create table if not exists doctors (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  name text not null,
  specialty text not null,
  avg_consult_min int not null default 12,
  status text not null default 'on_duty' check (status in ('on_duty', 'off_duty')),
  available_at timestamptz,
  shift_end timestamptz
);

create table if not exists patients (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  name text not null,
  phone text,
  language text not null default 'en',
  created_at timestamptz not null default now()
);

create table if not exists visits (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  patient_id uuid not null references patients(id) on delete cascade,
  doctor_id uuid not null references doctors(id),
  kind text not null check (kind in ('appointment', 'walk_in', 'follow_up')),
  status text not null check (status in ('scheduled', 'waiting', 'in_consult', 'done', 'no_show', 'cancelled')),
  priority text not null default 'normal' check (priority in ('emergency', 'urgent', 'normal')),
  priority_source text not null default 'default',
  token int,
  scheduled_at timestamptz,
  arrived_at timestamptz,
  consult_started_at timestamptz,
  consult_ended_at timestamptz,
  est_minutes int,
  reason text,
  parent_visit_id uuid references visits(id),
  fee_waived boolean not null default false,
  notes text,
  created_at timestamptz not null default now()
);
create index if not exists visits_clinic_status on visits (clinic_id, status);

-- Append-only event log: every change, who made it, and why. Powers "why did my position change?"
create table if not exists events (
  id bigserial primary key,
  clinic_id uuid not null references clinics(id) on delete cascade,
  visit_id uuid references visits(id) on delete cascade,
  doctor_id uuid references doctors(id) on delete cascade,
  type text not null,
  actor text not null check (actor in ('agent', 'staff', 'system', 'patient')),
  summary text not null,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists events_clinic_time on events (clinic_id, created_at desc);

-- Outbox: the agent drafts, a human approves, then it is "sent" (simulated SMS).
create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  visit_id uuid references visits(id) on delete cascade,
  patient_id uuid references patients(id) on delete cascade,
  kind text not null,
  channel text not null default 'sms',
  body text not null,
  status text not null default 'pending_approval' check (status in ('pending_approval', 'sent', 'rejected')),
  send_at timestamptz,
  drafted_by text,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);

-- Atomic token numbers per clinic per day.
create table if not exists token_counters (
  clinic_id uuid not null references clinics(id) on delete cascade,
  day date not null,
  last int not null default 0,
  primary key (clinic_id, day)
);

create or replace function next_token(p_clinic uuid, p_day date)
returns int language sql as $$
  insert into token_counters (clinic_id, day, last) values (p_clinic, p_day, 1)
  on conflict (clinic_id, day) do update set last = token_counters.last + 1
  returning last;
$$;

-- Model router telemetry: which lane/provider served each call, latency, failures.
create table if not exists llm_calls (
  id bigserial primary key,
  lane text not null,
  provider text not null,
  model text,
  purpose text,
  ok boolean not null,
  latency_ms int,
  error text,
  created_at timestamptz not null default now()
);

-- Self-hosted model registry: the Colab notebook announces its tunnel URL here via /api/runtime.
create table if not exists runtime_endpoints (
  name text primary key,
  url text not null,
  model text not null,
  last_seen_at timestamptz not null default now(),
  meta jsonb not null default '{}'
);

-- Read-only access for the browser (public demo, no PII beyond seeded fake names).
alter table clinics enable row level security;
alter table doctors enable row level security;
alter table patients enable row level security;
alter table visits enable row level security;
alter table events enable row level security;
alter table notifications enable row level security;
alter table token_counters enable row level security;
alter table llm_calls enable row level security;
alter table runtime_endpoints enable row level security;

do $$
declare t text;
begin
  foreach t in array array['clinics','doctors','patients','visits','events','notifications','llm_calls'] loop
    execute format('drop policy if exists "public read" on %I', t);
    execute format('create policy "public read" on %I for select using (true)', t);
  end loop;
end $$;

-- Realtime for live UI updates.
do $$
begin
  begin alter publication supabase_realtime add table visits; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table doctors; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table events; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table notifications; exception when duplicate_object then null; end;
end $$;

-- Shared quota ledger for the reasoning pool (works across serverless instances).
alter table llm_calls add column if not exists member text;
create index if not exists llm_calls_member_time on llm_calls (member, created_at desc);
create table if not exists model_cooldowns (
  member text primary key,
  until timestamptz not null,
  reason text
);
alter table model_cooldowns enable row level security;
