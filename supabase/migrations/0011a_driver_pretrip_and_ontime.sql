-- =====================================================================
-- GoldenWay — migration 0011: driver lane (Sprint 2 D3, D5 + on-time fix)
--
-- 1. start_run gains an optional p_note (pre-trip check note: bus
--    condition, odometer, anything worth logging before departure) —
--    stored straight into vehicle_runs.note, the same column
--    report_run_status already writes delay/breakdown notes into.
-- 2. report_run_status bugfix: completing a run (or marking it
--    DIVERTED) used to zero out delay_minutes unconditionally, which
--    erased the fact that a run had been delayed once it ended. Drivers
--    can't see an accurate "on-time %" for the week if every completed
--    run reports 0. Only ON_TIME explicitly clears the delay; COMPLETED
--    and DIVERTED keep whatever delay was last reported.
-- =====================================================================

drop function if exists public.start_run(text, text, text);

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

  v_day := case extract(dow from now())
             when 0 then 'SUNDAY' when 6 then 'SATURDAY' else 'WEEKDAY' end;

  insert into public.vehicle_runs (driver_id, route_code, bus_id, direction, service_day, note)
  values (auth.uid(), p_route_code, p_bus_id, p_direction, v_day, nullif(trim(p_note), ''))
  returning * into v_row;

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
  if p_status not in ('ON_TIME','DELAYED','BREAKDOWN','DIVERTED','COMPLETED') then
    raise exception 'status: invalid run status';
  end if;
  if p_delay_minutes < 0 then
    raise exception 'delayMinutes: cannot be negative';
  end if;
  if p_status = 'DELAYED' and p_delay_minutes <= 0 then
    raise exception 'delayMinutes: give the expected delay in minutes';
  end if;

  update public.vehicle_runs
    set status = p_status,
        delay_minutes = case
          when p_status in ('DELAYED','BREAKDOWN') then p_delay_minutes
          when p_status = 'ON_TIME' then 0
          else delay_minutes -- COMPLETED/DIVERTED: keep the last reported delay for on-time reporting
        end,
        note = coalesce(nullif(trim(p_note), ''), note),
        ended_at = case when p_status = 'COMPLETED' then now() else ended_at end
    where id = p_run_id
    returning * into v_row;

  return v_row;
end;
$$;
