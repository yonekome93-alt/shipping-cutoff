create extension if not exists pgcrypto with schema extensions;

create table if not exists public.shipping_cutoff_shared_state (
  workspace_id uuid primary key,
  pin_hash text not null,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.shipping_cutoff_shared_state enable row level security;
revoke all on table public.shipping_cutoff_shared_state from anon, authenticated;

insert into public.shipping_cutoff_shared_state (workspace_id, pin_hash, data)
values (
  '4dad83ad-0fb0-451f-b375-49595c06e538',
  extensions.crypt('7193', extensions.gen_salt('bf')),
  '{}'::jsonb
)
on conflict (workspace_id) do update
set pin_hash = excluded.pin_hash;

-- Server-side protection for the shared PIN. Authentication failures are
-- counted per workspace so rotating browsers or devices cannot bypass the
-- limit. Successful background syncs do not erase failures inside the active
-- window. This table is never exposed to anon/authenticated clients.
create table if not exists public.shipping_cutoff_pin_attempts (
  workspace_id uuid primary key references public.shipping_cutoff_shared_state(workspace_id) on delete cascade,
  failed_attempts integer not null default 0,
  window_started_at timestamptz not null default now(),
  locked_until timestamptz
);

alter table public.shipping_cutoff_pin_attempts enable row level security;
revoke all on table public.shipping_cutoff_pin_attempts from anon, authenticated;

create or replace function public.check_shipping_cutoff_pin(
  input_workspace uuid,
  input_pin text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  state_row public.shipping_cutoff_shared_state%rowtype;
  attempt_row public.shipping_cutoff_pin_attempts%rowtype;
  next_failures integer;
  lock_time timestamptz;
begin
  insert into public.shipping_cutoff_pin_attempts (workspace_id)
  select input_workspace
  where exists (
    select 1 from public.shipping_cutoff_shared_state where workspace_id = input_workspace
  )
  on conflict (workspace_id) do nothing;

  select * into attempt_row
  from public.shipping_cutoff_pin_attempts
  where workspace_id = input_workspace
  for update;

  if attempt_row.locked_until is not null and attempt_row.locked_until > now() then
    return jsonb_build_object(
      '__shipPaceAuthError', 'rate_limited',
      'retryAfterSeconds', greatest(1, ceil(extract(epoch from (attempt_row.locked_until - now())))::integer)
    );
  end if;

  if attempt_row.workspace_id is not null
     and (attempt_row.window_started_at < now() - interval '15 minutes'
          or (attempt_row.locked_until is not null and attempt_row.locked_until <= now())) then
    update public.shipping_cutoff_pin_attempts
    set failed_attempts = 0,
        window_started_at = now(),
        locked_until = null
    where workspace_id = input_workspace
    returning * into attempt_row;
  end if;

  select * into state_row
  from public.shipping_cutoff_shared_state
  where workspace_id = input_workspace;

  if state_row.workspace_id is not null
     and extensions.crypt(input_pin, state_row.pin_hash) = state_row.pin_hash then
    return jsonb_build_object('ok', true);
  end if;

  if attempt_row.workspace_id is null then
    return jsonb_build_object('__shipPaceAuthError', 'invalid_pin');
  end if;

  next_failures := attempt_row.failed_attempts + 1;
  lock_time := case when next_failures >= 5 then now() + interval '15 minutes' else null end;
  update public.shipping_cutoff_pin_attempts
  set failed_attempts = next_failures,
      locked_until = lock_time
  where workspace_id = input_workspace;

  if lock_time is not null then
    return jsonb_build_object(
      '__shipPaceAuthError', 'rate_limited',
      'retryAfterSeconds', 900
    );
  end if;

  return jsonb_build_object(
    '__shipPaceAuthError', 'invalid_pin',
    'remainingAttempts', greatest(0, 5 - next_failures)
  );
end;
$$;

revoke all on function public.check_shipping_cutoff_pin(uuid, text) from public;

create or replace function public.load_shipping_cutoff_state(
  input_workspace uuid,
  input_pin text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  row_data public.shipping_cutoff_shared_state%rowtype;
  auth_result jsonb;
begin
  auth_result := public.check_shipping_cutoff_pin(input_workspace, input_pin);
  if coalesce((auth_result->>'ok')::boolean, false) is not true then
    return auth_result;
  end if;

  select * into row_data
  from public.shipping_cutoff_shared_state
  where workspace_id = input_workspace;

  return row_data.data;
end;
$$;

drop function if exists public.save_shipping_cutoff_state(uuid, text, jsonb);

create or replace function public.save_shipping_cutoff_state(
  input_workspace uuid,
  input_pin text,
  input_data jsonb,
  input_expected_revision text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  row_data public.shipping_cutoff_shared_state%rowtype;
  auth_result jsonb;
begin
  auth_result := public.check_shipping_cutoff_pin(input_workspace, input_pin);
  if coalesce((auth_result->>'ok')::boolean, false) is not true then
    return auth_result;
  end if;

  select * into row_data
  from public.shipping_cutoff_shared_state
  where workspace_id = input_workspace
  for update;

  if coalesce(row_data.data->>'syncRevision', '') <> coalesce(input_expected_revision, '') then
    raise exception 'shared state conflict' using errcode = '40001';
  end if;

  update public.shipping_cutoff_shared_state
  set data = input_data,
      updated_at = now()
  where workspace_id = input_workspace
  returning * into row_data;

  return jsonb_build_object('updated_at', row_data.updated_at);
end;
$$;

revoke all on function public.load_shipping_cutoff_state(uuid, text) from public;
revoke all on function public.save_shipping_cutoff_state(uuid, text, jsonb, text) from public;
grant execute on function public.load_shipping_cutoff_state(uuid, text) to anon, authenticated;
grant execute on function public.save_shipping_cutoff_state(uuid, text, jsonb, text) to anon, authenticated;

create table if not exists public.shipping_cutoff_reports (
  id bigint generated by default as identity primary key,
  workspace_id uuid not null references public.shipping_cutoff_shared_state(workspace_id) on delete cascade,
  report_date date not null,
  summary jsonb not null default '{}'::jsonb,
  report_text text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, report_date)
);

create index if not exists shipping_cutoff_reports_workspace_date_idx
on public.shipping_cutoff_reports (workspace_id, report_date desc);

alter table public.shipping_cutoff_reports enable row level security;
revoke all on table public.shipping_cutoff_reports from anon, authenticated;

insert into public.shipping_cutoff_reports (
  workspace_id, report_date, summary, report_text, created_at, updated_at
)
select
  s.workspace_id,
  (r.item->>'date')::date,
  coalesce(r.item->'summary', '{}'::jsonb),
  coalesce(r.item->>'text', ''),
  coalesce((r.item->>'savedAt')::timestamptz, now()),
  coalesce((r.item->>'savedAt')::timestamptz, now())
from public.shipping_cutoff_shared_state s
cross join lateral jsonb_array_elements(
  case
    when jsonb_typeof(s.data->'reports') = 'array' then s.data->'reports'
    else '[]'::jsonb
  end
) as r(item)
where r.item->>'date' is not null
on conflict (workspace_id, report_date) do nothing;

create or replace function public.save_shipping_cutoff_report(
  input_workspace uuid,
  input_pin text,
  input_report_date date,
  input_summary jsonb,
  input_report_text text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  state_row public.shipping_cutoff_shared_state%rowtype;
  saved_row public.shipping_cutoff_reports%rowtype;
  auth_result jsonb;
begin
  auth_result := public.check_shipping_cutoff_pin(input_workspace, input_pin);
  if coalesce((auth_result->>'ok')::boolean, false) is not true then
    return auth_result;
  end if;

  select * into state_row
  from public.shipping_cutoff_shared_state
  where workspace_id = input_workspace;

  insert into public.shipping_cutoff_reports (
    workspace_id, report_date, summary, report_text
  )
  values (
    input_workspace, input_report_date, coalesce(input_summary, '{}'::jsonb), coalesce(input_report_text, '')
  )
  on conflict (workspace_id, report_date) do update
  set summary = excluded.summary,
      report_text = excluded.report_text,
      updated_at = now()
  returning * into saved_row;

  return jsonb_build_object(
    'report_date', saved_row.report_date,
    'updated_at', saved_row.updated_at
  );
end;
$$;

create or replace function public.load_shipping_cutoff_reports(
  input_workspace uuid,
  input_pin text,
  input_limit integer default 3650
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  state_row public.shipping_cutoff_shared_state%rowtype;
  result jsonb;
  auth_result jsonb;
begin
  auth_result := public.check_shipping_cutoff_pin(input_workspace, input_pin);
  if coalesce((auth_result->>'ok')::boolean, false) is not true then
    return auth_result;
  end if;

  select * into state_row
  from public.shipping_cutoff_shared_state
  where workspace_id = input_workspace;

  select coalesce(jsonb_agg(to_jsonb(r) order by r.report_date desc), '[]'::jsonb)
  into result
  from (
    select report_date, summary, report_text, created_at, updated_at
    from public.shipping_cutoff_reports
    where workspace_id = input_workspace
    order by report_date desc
    limit greatest(1, least(coalesce(input_limit, 3650), 10000))
  ) r;

  return result;
end;
$$;

revoke all on function public.save_shipping_cutoff_report(uuid, text, date, jsonb, text) from public;
revoke all on function public.load_shipping_cutoff_reports(uuid, text, integer) from public;
grant execute on function public.save_shipping_cutoff_report(uuid, text, date, jsonb, text) to anon, authenticated;
grant execute on function public.load_shipping_cutoff_reports(uuid, text, integer) to anon, authenticated;
