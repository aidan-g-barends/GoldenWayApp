-- =====================================================================
-- GoldenWay — migration 0012: driver lane production hardening
--
-- 1. SECURITY FIX: vehicle_runs_insert/update RLS only checked row
--    ownership (driver_id = auth.uid()), never that the caller actually
--    holds the DRIVER role. Any authenticated staff member (CLERK,
--    AGENT, INSPECTOR) could POST directly to /rest/v1/vehicle_runs
--    with driver_id set to their own uid and bypass start_run's route/
--    bus validation entirely — and, worse, PATCH status to DELAYED/
--    BREAKDOWN to fire a fake public service alert to commuters via
--    the 0006 trigger. Verified exploitable against the live project
--    2026-09-16 (CLERK demo account inserted a fabricated run), fixed
--    here and re-verified blocked.
-- 2. Input sanity: note length capped (it ends up in a public service
--    alert body) and delay_minutes capped at a sane ceiling.
-- 3. start_run now raises a friendly message instead of a raw
--    unique_violation when a driver double-taps "Start run" while a
--    run is already open (uq_vehicle_runs_open_per_driver).
-- =====================================================================

drop policy if exists vehicle_runs_insert on public.vehicle_runs;
create policy vehicle_runs_insert on public.vehicle_runs
  for insert with check (
    (driver_id = auth.uid() and public.is_staff('DRIVER'))
    or public.is_staff('ADMIN')
  );

drop policy if exists vehicle_runs_update on public.vehicle_runs;
create policy vehicle_runs_update on public.vehicle_runs
  for update using (
    (driver_id = auth.uid() and public.is_staff('DRIVER'))
    or public.is_staff('ADMIN')
  )
  with check (
    (driver_id = auth.uid() and public.is_staff('DRIVER'))
    or public.is_staff('ADMIN')
  );

create or replace function public.start_run(
  p_route_code text,
  p_bus_id text,
  p_direction text default 'OUTBOUND',
  p_note text default null
)
returns public.vehicle_runs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.vehicle_runs;
  v_role text;
  v_day text;
  v_note text;
begin
  select role into v_role from public.staff where id = auth.uid() and active;
  if v_role is null or v_role not in ('DRIVER','ADMIN') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  if not exists (select 1 from public.routes where code = p_route_code and active) then
    raise exception 'routeCode: unknown or inactive route %', p_route_code;
  end if;
  if not exists (select 1 from public.buses where fleet_no = p_bus_id and active) then
    raise exception 'busId: unknown or inactive bus %', p_bus_id;
  end if;
  if p_direction not in ('OUTBOUND','INBOUND') then
    raise exception 'direction: must be OUTBOUND or INBOUND';
  end if;

  v_note := nullif(trim(p_note), '');
  if v_note is not null and length(v_note) > 300 then
    raise exception 'note: keep it under 300 characters';
  end if;

  v_day := case extract(dow from now())
             when 0 then 'SUNDAY' when 6 then 'SATURDAY' else 'WEEKDAY' end;

  begin
    insert into public.vehicle_runs (driver_id, route_code, bus_id, direction, service_day, note)
    values (auth.uid(), p_route_code, p_bus_id, p_direction, v_day, v_note)
    returning * into v_row;
  exception
    when unique_violation then
      raise exception 'You already have a run in progress — end it before starting another.';
  end;

  return v_row;
end;
$$;

create or replace function public.report_run_status(
  p_run_id bigint,
  p_status text,
  p_delay_minutes int default 0,
  p_note text default null
)
returns public.vehicle_runs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.vehicle_runs;
  v_role text;
  v_note text;
begin
  select role into v_role from public.staff where id = auth.uid() and active;
  if v_role is null or v_role not in ('DRIVER','ADMIN') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  select * into v_row from public.vehicle_runs where id = p_run_id;
  if v_row is null then
    raise exception 'Run % not found', p_run_id;
  end if;
  if v_row.driver_id <> auth.uid() and v_role <> 'ADMIN' then
    raise exception 'FORBIDDEN: this is not your run' using errcode = '42501';
  end if;
  if v_row.status = 'COMPLETED' then
    raise exception 'This run has already ended.';
  end if;
  if p_status not in ('ON_TIME','DELAYED','BREAKDOWN','DIVERTED','COMPLETED') then
    raise exception 'status: invalid run status';
  end if;
  if p_delay_minutes < 0 then
    raise exception 'delayMinutes: cannot be negative';
  end if;
  if p_delay_minutes > 480 then
    raise exception 'delayMinutes: that''s a big number — contact your depot for a longer service disruption';
  end if;
  if p_status = 'DELAYED' and p_delay_minutes <= 0 then
    raise exception 'delayMinutes: give the expected delay in minutes';
  end if;

  v_note := nullif(trim(p_note), '');
  if v_note is not null and length(v_note) > 300 then
    raise exception 'note: keep it under 300 characters';
  end if;

  update public.vehicle_runs
    set status = p_status,
        delay_minutes = case
          when p_status in ('DELAYED','BREAKDOWN') then p_delay_minutes
          when p_status = 'ON_TIME' then 0
          else delay_minutes -- COMPLETED/DIVERTED: keep the last reported delay for on-time reporting
        end,
        note = coalesce(v_note, note),
        ended_at = case when p_status = 'COMPLETED' then now() else ended_at end
    where id = p_run_id
    returning * into v_row;

  return v_row;
end;
$$;
