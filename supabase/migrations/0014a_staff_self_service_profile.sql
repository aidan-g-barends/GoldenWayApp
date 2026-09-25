-- =====================================================================
-- GoldenWay — migration 0014: staff self-service profile (Update/Delete)
--
-- Staff could Create (staff-signup request → admin approval) and Read
-- their own account, but not Update or Delete it — staff_update_admin
-- RLS is ADMIN-only by design (role/active changes stay admin-owned),
-- so a self-service edit needs its own narrowly-scoped RPC rather than
-- opening the table's RLS to self-writes.
--
-- 1. update_my_staff_profile — self-only edit of first_name/surname/
--    phone. Deliberately cannot touch role/active/email — those stay
--    admin-controlled (role changes = a new access request; email is
--    the auth identity).
-- 2. deactivate_my_account — the "Delete" equivalent. True hard-delete
--    isn't safe here: staff.id is referenced by vehicle_runs,
--    inspection_events, gold_cards.issued_by, support_tickets and
--    staff_action_log with no ON DELETE CASCADE, so a real DELETE
--    would either fail on FK violation or silently orphan audit data.
--    Matches the app's existing soft-state convention (runs end
--    COMPLETED, cards go UNREGISTERED, staff go inactive — nothing
--    is hard-deleted anywhere else either). Blocks self-deactivation
--    while a run is still open so a driver can't vanish mid-shift.
-- =====================================================================

create or replace function public.update_my_staff_profile(
  p_first_name text,
  p_surname text,
  p_phone text default null
)
returns public.staff
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.staff;
  v_phone text;
begin
  if auth.uid() is null then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if not exists (select 1 from public.staff where id = auth.uid()) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_first_name is null or trim(p_first_name) = '' then
    raise exception 'firstName: required';
  end if;
  if p_surname is null or trim(p_surname) = '' then
    raise exception 'surname: required';
  end if;

  v_phone := nullif(trim(p_phone), '');
  if v_phone is not null and v_phone !~ '^(\+27|0)\d{9}$' then
    raise exception 'phone: use an SA number, e.g. 0821234567';
  end if;

  update public.staff
    set first_name = trim(p_first_name),
        surname = trim(p_surname),
        phone = v_phone
    where id = auth.uid()
    returning * into v_row;

  return v_row;
end;
$$;

create or replace function public.deactivate_my_account()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
begin
  select role into v_role from public.staff where id = auth.uid() and active;
  if v_role is null then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  if exists (select 1 from public.vehicle_runs where driver_id = auth.uid() and ended_at is null) then
    raise exception 'You have a run in progress — end it before deactivating your account.';
  end if;

  update public.staff set active = false where id = auth.uid();
  return true;
end;
$$;
