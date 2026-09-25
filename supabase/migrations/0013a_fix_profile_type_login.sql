-- =====================================================================
-- GoldenWay — migration 0013: fix staff login misrouting
--
-- my_profile_type() used `if v_staff is not null then` to decide "was a
-- staff row found?". In Postgres, a composite/row variable's IS NOT NULL
-- means "every column is non-null" — NOT "a row was assigned". staff.phone
-- is nullable and unset on every demo account, so the check silently
-- failed for every staff member, misrouting all staff logins down the
-- commuter path (which then fails with "no commuter profile"). Verified
-- against the live project 2026-09-16: FOUND was true and every non-
-- nullable field (id, role, email) was populated, yet `v_staff is not
-- null` still evaluated false because of the null phone column.
--
-- Fix: use FOUND (PL/pgSQL's built-in "did the last SELECT INTO match a
-- row?" flag), which is exactly what was intended and isn't affected by
-- nullable columns.
--
-- Same bug found in handle_staff_signup() further down this same file:
-- `if v_req is not null then` on a public.staff_access_requests row,
-- whose motivation/decision_note/onboarded_at columns are nullable. An
-- approved request with no motivation note would silently fail to
-- provision the new staff row when the applicant signs up — part of
-- the admin-approval onboarding path (MULTIROLE-PLAN Q2). Same fix.
-- =====================================================================

create or replace function public.my_profile_type()
returns json
language plpgsql
stable security definer
set search_path to 'public'
as $$
declare
  v_staff public.staff;
begin
  if auth.uid() is null then
    return null;
  end if;
  select * into v_staff from public.staff where staff.id = auth.uid();
  if found then
    return json_build_object(
      'userType', 'STAFF', 'role', v_staff.role, 'active', v_staff.active,
      'firstName', v_staff.first_name, 'surname', v_staff.surname,
      'email', v_staff.email);
  end if;
  if exists (select 1 from public.commuters where commuters.id = auth.uid()) then
    return json_build_object('userType', 'COMMUTER');
  end if;
  return json_build_object('userType', 'UNPROFILED');
end;
$$;

create or replace function public.handle_staff_signup()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req public.staff_access_requests;
begin
  if new.email is null then
    return new;
  end if;
  select * into v_req from public.staff_access_requests
    where lower(email) = lower(new.email) and status = 'APPROVED'
    order by decided_at desc limit 1;
  if found then
    insert into public.staff (id, first_name, surname, email, role, active)
    values (new.id, v_req.first_name, v_req.surname, new.email, v_req.requested_role, true)
    on conflict (id) do nothing;
    update public.staff_access_requests set onboarded_at = now() where id = v_req.id;
    insert into public.staff_action_log (actor_id, action, entity, entity_id, details)
    values (new.id, 'STAFF_ONBOARDED', 'staff', new.id::text,
            jsonb_build_object('email', new.email, 'role', v_req.requested_role));
  end if;
  return new;
end;
$$;
