-- =====================================================================
-- GoldenWay — migration 0014: reconcile live state
--
-- This migration exists because manual fixes were applied directly in
-- the Supabase SQL Editor (bug fixes + schema improvements) that were
-- never captured as migration files. Running 0001-0013 fresh on a new
-- project would NOT reproduce the current working database — it would
-- reproduce the broken register_commuter, the insecure gold_cards
-- insert policy, and would be missing four functions, two columns,
-- and one trigger that are live in production right now.
--
-- This file is written to be safe to run even though most of its
-- changes are ALREADY applied to the live DB — every statement uses
-- IF NOT EXISTS / OR REPLACE / IF EXISTS so re-running it is a no-op
-- where it's already applied, and does the real work on a fresh DB.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. commuters: gender field removed per course requirement.
--    (0001_schema.sql still creates this column — this formally
--    retires it so a from-scratch build matches production.)
-- ---------------------------------------------------------------------

alter table public.commuters drop column if exists gender;

-- ---------------------------------------------------------------------
-- 2. register_commuter: drop the old 7-arg signature (gender removed),
--    recreate as 6-arg. Postgres treats a changed argument list as a
--    different function, so the old one must be dropped explicitly or
--    it lingers as dead, callable, broken code.
-- ---------------------------------------------------------------------

drop function if exists public.register_commuter(text, text, text, text, date, text, text);

create or replace function public.register_commuter(
  p_first_name text,
  p_surname text,
  p_phone text,
  p_date_of_birth date,
  p_id_number text,
  p_concession_type text
)
returns public.commuters
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
  v_row public.commuters;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;

  select email into v_email from auth.users where id = auth.uid();

  if p_first_name is null or trim(p_first_name) = '' then
    raise exception 'firstName: must not be blank';
  end if;
  if p_surname is null or trim(p_surname) = '' then
    raise exception 'surname: must not be blank';
  end if;
  if p_phone !~ '^(\+27|0)\d{9}$' then
    raise exception 'phone: must be a SA mobile number (+27xxxxxxxxx or 0xxxxxxxxx)';
  end if;
  if p_date_of_birth is null or p_date_of_birth > (current_date - interval '5 years')::date then
    raise exception 'dateOfBirth: must be a valid date of birth (age 5 or older)';
  end if;
  if not public.sa_id_luhn_valid(p_id_number) then
    raise exception 'idNumber: this ID number fails the checksum — please check it';
  end if;
  if p_concession_type not in ('NONE','STUDENT','PENSIONER') then
    raise exception 'concessionType: must be NONE, STUDENT or PENSIONER';
  end if;
  if exists (select 1 from public.commuters where id_number = p_id_number) then
    raise exception 'idNumber: an account already exists with this ID number' using errcode = '23505';
  end if;

  insert into public.commuters (
    id, first_name, surname, email, phone, date_of_birth, id_number, concession_type
  ) values (
    auth.uid(), trim(p_first_name), trim(p_surname), v_email, p_phone,
    p_date_of_birth, p_id_number, upper(p_concession_type)
  )
  returning * into v_row;

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------
-- 3. gold_cards: close the direct-insert hole. Every legitimate card-
--    creation path (get_or_create_my_card, order_gold_card,
--    link_existing_card, clerk_issue_card, clerk_replace_lost_card) is
--    SECURITY DEFINER and bypasses RLS entirely — this policy served
--    no purpose except letting any authenticated user insert an
--    arbitrary gold_cards row, including one claiming someone else's
--    owner_id.
-- ---------------------------------------------------------------------

drop policy if exists gold_cards_insert on public.gold_cards;

-- ---------------------------------------------------------------------
-- 4. staff: presence tracking (real "agent online" status, replacing
--    the FINAL-DEV-PLAN placeholder of "any active AGENT/ADMIN").
-- ---------------------------------------------------------------------

alter table public.staff add column if not exists last_seen_at timestamptz;

create or replace function public.set_agent_online(p_online boolean default true)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_staff('AGENT', 'ADMIN') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  update public.staff
    set last_seen_at = case when p_online then now() else null end
    where id = auth.uid();
end;
$$;

-- ---------------------------------------------------------------------
-- 5. staff: manual attach fallback. Covers the case where an ADMIN
--    approves a request but the two automatic triggers (0005's
--    handle_staff_signup, 0012's provision_staff_on_approval) missed
--    the window for some reason — gives the admin a manual recovery
--    path instead of a dead end.
-- ---------------------------------------------------------------------

create or replace function public.attach_staff_to_existing_account(p_request_id bigint)
returns public.staff
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req    public.staff_access_requests;
  v_user   record;
  v_row    public.staff;
begin
  if not public.is_staff('ADMIN') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  select * into v_req from public.staff_access_requests where id = p_request_id;
  if v_req is null then
    raise exception 'Request % not found', p_request_id;
  end if;
  if v_req.status <> 'APPROVED' then
    raise exception 'status: request must be APPROVED first (currently %)', v_req.status;
  end if;

  select id into v_user from auth.users where lower(email) = lower(v_req.email) limit 1;
  if v_user is null then
    raise exception 'email: no account exists yet for % -- ask them to sign up first', v_req.email;
  end if;

  if exists (select 1 from public.staff where id = v_user.id) then
    select * into v_row from public.staff where id = v_user.id;
    update public.staff_access_requests set onboarded_at = coalesce(onboarded_at, now()) where id = v_req.id;
    return v_row;
  end if;

  insert into public.staff (id, first_name, surname, email, role, active)
  values (v_user.id, v_req.first_name, v_req.surname, v_req.email, v_req.requested_role, true)
  returning * into v_row;

  update public.staff_access_requests set onboarded_at = now() where id = v_req.id;

  insert into public.staff_action_log (actor_id, action, entity, entity_id, details)
  values (auth.uid(), 'STAFF_ATTACHED_MANUALLY', 'staff', v_user.id::text,
          jsonb_build_object('email', v_req.email, 'role', v_req.requested_role, 'request_id', v_req.id));

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------
-- 6. staff: self-service account deactivation. Guards against a driver
--    deactivating mid-run, leaving a vehicle_runs row open forever.
-- ---------------------------------------------------------------------

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

-- ---------------------------------------------------------------------
-- 7. support_tickets: denormalized last-message fields, to avoid a
--    per-row subquery in ticket_queue(). Kept in sync by the trigger
--    below.
-- ---------------------------------------------------------------------

alter table public.support_tickets add column if not exists last_message_at timestamptz;
alter table public.support_tickets add column if not exists last_sender text
  check (last_sender in ('COMMUTER','AGENT'));

create or replace function public.touch_ticket_last_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.support_tickets
    set last_message_at = new.sent_at, last_sender = new.sender
    where id = new.ticket_id;
  return new;
end;
$$;

drop trigger if exists on_ticket_message_touch on public.ticket_messages;
create trigger on_ticket_message_touch
  after insert on public.ticket_messages
  for each row execute function public.touch_ticket_last_message();

-- ---------------------------------------------------------------------
-- 8. Grants — the two new RPCs need to be callable the same way every
--    other RPC in this project is (0002's blanket grant only covered
--    what existed at the time it ran).
-- ---------------------------------------------------------------------

grant execute on function public.set_agent_online(boolean) to authenticated;
grant execute on function public.attach_staff_to_existing_account(bigint) to authenticated;
grant execute on function public.deactivate_my_account() to authenticated;