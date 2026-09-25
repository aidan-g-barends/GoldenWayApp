-- =====================================================================
-- GoldenWay — migration 0011: staff OTP onboarding (v2 — Resend edition)
-- reviewed rewrite: 2026-09-16
--
-- Fixes vs v1:
--   · OTP bound to staff_access_requests.id (not just email)
--   · gen_random_bytes() instead of random()
--   · SELECT … FOR UPDATE closes the double-verify race
--   · claim_signup_slot() hard-fails without a live APPROVED request
--   · NO plaintext OTP in staff_action_log — an outbox row + a real
--     Supabase Edge Function (send-staff-otp) + Resend deliver the code
--   · explicit GRANT/REVOKE on every public function
--
-- Flow:  decide_staff_access → APPROVED → trigger → OTP row + outbox row
--        → Edge Function drains outbox → Resend → applicant's inbox
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. Ensure pgcrypto (gen_random_bytes) is available
-- ---------------------------------------------------------------------

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------
-- 1. OTP table — bound to the request
-- ---------------------------------------------------------------------

create table if not exists public.staff_onboarding_codes (
  id                       bigint generated always as identity primary key,
  staff_access_request_id  bigint not null references public.staff_access_requests(id) on delete cascade,
  email                    text not null,
  code_hash                text not null,
  expires_at               timestamptz not null,
  attempts                 int not null default 0,
  last_attempt_at          timestamptz,
  consumed_at              timestamptz,
  created_at               timestamptz not null default now()
);

-- One live code per request (re-approval recycles via on conflict).
create unique index if not exists uq_staff_codes_request
  on public.staff_onboarding_codes (staff_access_request_id);

create index if not exists idx_staff_codes_email
  on public.staff_onboarding_codes (lower(email), created_at desc);

-- RLS enabled, zero policies: only the SECURITY DEFINER RPCs below and
-- the service_role (Edge Function) touch this table. Clients can never
-- read or write it directly.
alter table public.staff_onboarding_codes enable row level security;

-- ---------------------------------------------------------------------
-- 2. Email outbox — the ONLY thing the trigger writes besides the OTP
--    A pending job row; the Edge Function drains it and marks it sent.
--    Postgres never performs network I/O.
-- ---------------------------------------------------------------------

create table if not exists public.staff_otp_outbox (
  id           bigint generated always as identity primary key,
  request_id   bigint not null references public.staff_access_requests(id) on delete cascade,
  email        text not null,
  code         text not null,          -- plaintext, readable ONLY by service_role
  status       text not null default 'PENDING'
               check (status in ('PENDING','SENT','FAILED')),
  attempts     int not null default 0,
  last_error   text,
  created_at   timestamptz not null default now(),
  sent_at      timestamptz
);

create index if not exists idx_outbox_pending
  on public.staff_otp_outbox (created_at) where status = 'PENDING';

-- RLS enabled, zero policies: anon/authenticated see nothing. The Edge
-- Function reads it with the service_role key, which bypasses RLS.
alter table public.staff_otp_outbox enable row level security;

-- ---------------------------------------------------------------------
-- 3. OTP helpers
-- ---------------------------------------------------------------------

create or replace function public.staff_code_hash(p_code text)
returns text
language sql
stable
as $$
  select encode(extensions.digest('gw-staff-onboarding:' || lower(trim(p_code)), 'sha256'), 'hex');
$$;

revoke execute on function public.staff_code_hash(text) from public, anon, authenticated;

-- Issue (or recycle) the code for a request. Returns the PLAIN code to
-- the caller (the approval trigger) so it can be queued for delivery.
create or replace function public.issue_staff_code(p_request_id bigint)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req    public.staff_access_requests;
  v_code   text;
  v_hash   text;
begin
  select * into v_req from public.staff_access_requests where id = p_request_id;
  if v_req is null then
    raise exception 'Request % not found', p_request_id;
  end if;

  -- Cryptographically random 6 digits (100000–999999).
  v_code := encode(extensions.gen_random_bytes(4), 'hex');
  v_code := ((('x' || v_code)::bit(32)::bigint % 900000) + 100000)::text;
  v_hash := public.staff_code_hash(v_code);

  insert into public.staff_onboarding_codes
    (staff_access_request_id, email, code_hash, expires_at)
  values
    (v_req.id, v_req.email, v_hash, now() + interval '24 hours')
  on conflict (staff_access_request_id) do update
    set code_hash   = excluded.code_hash,
        email       = excluded.email,
        expires_at  = excluded.expires_at,
        attempts    = 0,
        last_attempt_at = null,
        consumed_at = null,
        created_at  = now()
  returning code_hash into v_hash;   -- silence unused-var warning path

  -- Queue the delivery job. The Edge Function (send-staff-otp) picks
  -- PENDING rows up and emails the code via Resend.
  insert into public.staff_otp_outbox (request_id, email, code)
  values (v_req.id, v_req.email, v_code)
  on conflict do nothing;            -- no unique constraint; harmless

  return v_code;
end;
$$;

revoke execute on function public.issue_staff_code(bigint) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. Approval trigger — INSERT and UPDATE (covers decide_staff_access
--    via UPDATE and create_staff_member via INSERT … ON CONFLICT).
--    A PENDING→APPROVED update or a fresh APPROVED insert issues one
--    code + one outbox job. Safe under the WHEN guards.
-- ---------------------------------------------------------------------

create or replace function public.handle_staff_decision_code()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.issue_staff_code(new.id);
  return new;
end;
$$;

-- Postgres limitation: a trigger declared "after insert or update" cannot
-- reference OLD in its WHEN clause (OLD does not exist on INSERT) — so this
-- is two triggers instead of one:
--
--   · INSERT: a row arriving already APPROVED (create_staff_member's
--     fast-track invite in 0005) is a new approval by definition — no OLD
--     check needed.
--   · UPDATE: only a transition INTO approved fires (PENDING→APPROVED via
--     decide_staff_access, DENIED→APPROVED on re-approval). An UPDATE that
--     leaves the row already APPROVED no-ops — importantly this covers
--     create_staff_member re-inviting an APPROVED person via
--     INSERT … ON CONFLICT DO UPDATE, which Postgres routes through the
--     UPDATE trigger (OLD.status = 'APPROVED' ⇒ WHEN fails ⇒ no duplicate
--     code/email).

drop trigger if exists on_staff_decision_code_ins on public.staff_access_requests;
create trigger on_staff_decision_code_ins
  after insert on public.staff_access_requests
  for each row
  when (new.status = 'APPROVED')
  execute function public.handle_staff_decision_code();

drop trigger if exists on_staff_decision_code_upd on public.staff_access_requests;
create trigger on_staff_decision_code_upd
  after update of status on public.staff_access_requests
  for each row
  when (new.status = 'APPROVED' and old.status is distinct from 'APPROVED')
  execute function public.handle_staff_decision_code();

-- ---------------------------------------------------------------------
-- 5. Public RPCs — the applicant surface (only these two are exposed)
-- ---------------------------------------------------------------------

-- Verify the code: request-bound, FOR UPDATE (no double-verify race),
-- 24 h expiry, 5 attempts, 30 s between attempts. Consumes on success
-- and opens the 10-minute signup slot.
--
-- v3: a WRONG code returns { ok: false, error, attemptsLeft } instead of
-- raising — the caller keeps a 200 so the attempts increment below can
-- actually commit (raising would roll the whole transaction back, so
-- the counter never moved). Hard configuration/rate errors still raise.
create or replace function public.verify_staff_code(
  p_email text,
  p_code text
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row   public.staff_onboarding_codes;
  v_req   public.staff_access_requests;
begin
  if p_email is null or p_code is null
     or btrim(p_code) !~ '^\d{6}$' then
    raise exception 'code: enter your email and the 6-digit code';
  end if;

  -- Lock the newest live code row for this email. FOR UPDATE makes the
  -- read-check-consume sequence atomic against concurrent verifications.
  select c.* into v_row
    from public.staff_onboarding_codes c
    where lower(c.email) = lower(btrim(p_email))
      and c.consumed_at is null
      and c.expires_at > now()
    order by c.created_at desc
    limit 1
    for update of c;

  if v_row is null then
    raise exception 'code: no pending code for this email — ask your admin to re-approve';
  end if;

  -- 30 s between attempts (rate limit)
  if v_row.last_attempt_at is not null
     and v_row.last_attempt_at > now() - interval '30 seconds' then
    raise exception 'code: wait 30 seconds between attempts';
  end if;

  -- Attempt cap
  if v_row.attempts >= 5 then
    raise exception 'code: too many wrong attempts — ask your admin to re-approve';
  end if;

  -- Wrong code: record the attempt and answer WITHOUT raising, so this
  -- update commits (the whole point of the v3 change).
  if v_row.code_hash <> public.staff_code_hash(p_code) then
    update public.staff_onboarding_codes
      set attempts = attempts + 1, last_attempt_at = now()
      where id = v_row.id;
    return json_build_object(
      'ok', false,
      'error', 'code: that code is not right — '
               || greatest(0, 4 - v_row.attempts) || ' attempt(s) left',
      'attemptsLeft', greatest(0, 4 - v_row.attempts)
    );
  end if;

  -- Correct: consume + resolve the request
  update public.staff_onboarding_codes
    set consumed_at = now()
    where id = v_row.id;

  select * into v_req from public.staff_access_requests
    where id = v_row.staff_access_request_id
      and status = 'APPROVED';

  if v_req is null then
    raise exception 'code: the approved request for this code is no longer active';
  end if;

  return json_build_object(
    'ok', true,
    'requestId', v_req.id,
    'role', v_req.requested_role,
    'firstName', v_req.first_name,
    'surname', v_req.surname,
    'email', v_req.email
  );
end;
$$;

grant execute on function public.verify_staff_code(text, text) to anon, authenticated;

-- Proof-of-verification gate, called right before auth.signUp().
-- Hard-fails when: no live APPROVED request, slot expired, or already
-- onboarded. Never falls back to a default role.
create or replace function public.claim_signup_slot(p_email text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row  public.staff_onboarding_codes;
  v_req  public.staff_access_requests;
begin
  select c.* into v_row
    from public.staff_onboarding_codes c
    where lower(c.email) = lower(btrim(p_email))
      and c.consumed_at is not null
      and c.consumed_at > now() - interval '10 minutes'
    order by c.created_at desc
    limit 1;

  if v_row is null then
    raise exception 'code: verify your 6-digit staff code first';
  end if;

  select * into v_req from public.staff_access_requests
    where id = v_row.staff_access_request_id
      and status = 'APPROVED'
      and onboarded_at is null;

  if v_req is null then
    raise exception 'code: this approval has already been used or is no longer active';
  end if;

  return json_build_object(
    'ok', true,
    'requestId', v_req.id,
    'role', v_req.requested_role,
    'firstName', v_req.first_name,
    'surname', v_req.surname,
    'email', v_req.email
  );
end;
$$;

grant execute on function public.claim_signup_slot(text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 6. Audit log: record THAT a code was issued — never the code itself.
--    (The Edge Function's own logs live in Supabase, not in Postgres.)
-- ---------------------------------------------------------------------

create or replace function public.log_staff_code_issued()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.staff_action_log (actor_id, action, entity, entity_id, details)
  values (auth.uid(), 'ISSUE_STAFF_CODE', 'staff_access_requests', new.request_id::text,
          jsonb_build_object('email', new.email, 'expires_at', now() + interval '24 hours'));
  return new;
end;
$$;

drop trigger if exists on_outbox_code_issued on public.staff_otp_outbox;
create trigger on_outbox_code_issued
  after insert on public.staff_otp_outbox
  for each row
  execute function public.log_staff_code_issued();
