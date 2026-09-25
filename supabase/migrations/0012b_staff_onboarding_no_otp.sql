-- =====================================================================
-- GoldenWay — migration 0012: staff onboarding WITHOUT email/OTP
-- =====================================================================
--
-- Replaces the 0011 OTP design. Entry to any staff dashboard is gated on
-- ONE thing: a live row in public.staff (every role guard already reads
-- it via is_staff() / my_profile_type()). No email, no OTP, no Resend.
--
-- New flow:
--   applicant: request_staff_access() + supabase.auth.signUp()
--              (one form: name, email, role, motivation, password)
--   admin:     decide_staff_access(approve) in the onboarding queue
--   trigger:   APPROVED → staff row created → dashboard unlocked on
--              next sign-in (my_profile_type returns STAFF)
--   trigger:   DENIED → notifications cleaned up, auth user DELETED
--              (the applicant can reapply from scratch)
--   sign-in:   valid credentials but no staff row yet → UNPROFILED →
--              the app signs the user out with "awaiting approval"
--              (loginAny checks my_staff_request_status)
--
-- Requires: Confirm email OFF in Supabase Auth (SETUP.md §3) so signUp()
-- returns a live session immediately and the PENDING applicant row is
-- discoverable via my_staff_request_status().
--
-- NOTE: the deny trigger needs rights to delete from auth.users. When
-- applying via the Dashboard SQL Editor you run as postgres, which owns
-- that table — fine for the demo. (A programmatic `supabase db push`
-- runs with the same role.)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Tear down 0011 (OTP edition) — idempotent
-- ---------------------------------------------------------------------

drop trigger if exists on_outbox_code_issued      on public.staff_otp_outbox;
drop trigger if exists on_staff_decision_code_ins on public.staff_access_requests;
drop trigger if exists on_staff_decision_code_upd on public.staff_access_requests;

drop function if exists public.log_staff_code_issued();
drop function if exists public.handle_staff_decision_code();
drop function if exists public.issue_staff_code(bigint);
drop function if exists public.staff_code_hash(text);
drop function if exists public.verify_staff_code(text, text);
drop function if exists public.claim_signup_slot(text);

drop table if exists public.staff_otp_outbox;
drop table if exists public.staff_onboarding_codes;

-- ---------------------------------------------------------------------
-- 2. Approval provisioning — APPROVED request + existing auth user
--    ⇒ staff row. Covers the new order (signup BEFORE approval) and
--    idempotent re-approval. The order signup-AFTER-approval (fast-track
--    invite) stays covered by 0005's on_auth_user_staff_signup trigger.
-- ---------------------------------------------------------------------

create or replace function public.provision_staff_on_approval()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid;
begin
  if new.status = 'APPROVED' and coalesce(old.status, '') is distinct from 'APPROVED' then
    select u.id into v_uid from auth.users u
      where lower(u.email) = lower(new.email) limit 1;

    if v_uid is not null then
      insert into public.staff (id, first_name, surname, email, role, active)
      values (v_uid, new.first_name, new.surname, new.email, new.requested_role, true)
      on conflict (id) do update
        set first_name = excluded.first_name,
            surname    = excluded.surname,
            role       = excluded.role,
            active     = true;   -- re-approval also re-activates

      update public.staff_access_requests
        set onboarded_at = coalesce(onboarded_at, now())
        where id = new.id and onboarded_at is null;

      insert into public.staff_action_log (actor_id, action, entity, entity_id, details)
      values (auth.uid(), 'STAFF_ONBOARDED', 'staff', v_uid::text,
              jsonb_build_object('email', new.email, 'role', new.requested_role));
    end if;
    -- v_uid is null → not signed up yet; the 0005 signup trigger will
    -- onboard them when they do.
  end if;
  return new;
end;
$$;

drop trigger if exists on_staff_decision_provision on public.staff_access_requests;
create trigger on_staff_decision_provision
  after update of status on public.staff_access_requests
  for each row
  execute function public.provision_staff_on_approval();

-- ---------------------------------------------------------------------
-- 3. Denial cleanup — a DENIED request must not leave working
--    credentials behind. The auth user (created by the applicant at
--    sign-up) is deleted along with anything that points at it.
--    Guards: never touch a commuter, never touch a live staff row.
-- ---------------------------------------------------------------------

create or replace function public.purge_applicant_on_denial()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid;
begin
  if new.status = 'DENIED' and coalesce(old.status, '') is distinct from 'DENIED' then
    select u.id into v_uid from auth.users u
      where lower(u.email) = lower(new.email) limit 1;

    if v_uid is not null
       and not exists (select 1 from public.commuters c where c.id = v_uid)
       and not exists (select 1 from public.staff s where s.id = v_uid) then
      delete from public.notifications where user_id = v_uid;
      delete from auth.users where id = v_uid;
      insert into public.staff_action_log (actor_id, action, entity, entity_id, details)
      values (auth.uid(), 'PURGE_DENIED_APPLICANT', 'staff_access_requests', new.id::text,
              jsonb_build_object('email', new.email, 'auth_user', v_uid::text));
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists on_staff_decision_purge on public.staff_access_requests;
create trigger on_staff_decision_purge
  after update of status on public.staff_access_requests
  for each row
  execute function public.purge_applicant_on_denial();

-- ---------------------------------------------------------------------
-- 4. RLS touch-up — the sign-in gate reads the applicant's own request
--    row after they have signed up (auth.uid() exists), so mirror the
--    "own email OR ADMIN" rule onto the auth.users email. 0005's policy
--    only allowed this via a commuters-style check; widen it to any
--    signed-in user whose auth email matches the row.
--
--    NOTE: the email comparison MUST go through the security-definer
--    helper public.my_email() (0010) — a raw subquery on auth.users
--    runs with the invoker's privileges and anon/authenticated have no
--    SELECT grant there, which 42501s every read of this table.
-- ---------------------------------------------------------------------

drop policy if exists staff_requests_read on public.staff_access_requests;
create policy staff_requests_read on public.staff_access_requests
  for select using (
    public.is_staff('ADMIN')
    or (
      auth.uid() is not null
      and lower(email) = lower(coalesce(public.my_email(), ''))
    )
  );

-- ---------------------------------------------------------------------
-- 5. Notes
--    · decide_staff_access / request_staff_access / create_staff_member
--      (0005) are unchanged — the admin door and the request form are
--      exactly what they were.
--    · my_profile_type / my_staff_request_status (0005) are unchanged —
--      UNPROFILED + PENDING is the "awaiting approval" signal the login
--      gate uses; APPROVED + UNPROFILED no longer occurs (approval
--      provisions immediately), but the code path tolerates it.
--    · notifications.on_staff_decision (0007) is unchanged — on approval
--      it now actually finds the applicant's auth account and notifies
--      them; it fires before the purge trigger on denial, so the DENIED
--      notification is written and then removed with the account (the
--      applicant is gone; there is nobody left to notify).
-- ---------------------------------------------------------------------
