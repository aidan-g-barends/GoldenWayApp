-- =====================================================================
-- GoldenWay — migration 0018: staff request email pre-check
--
-- request_staff_access() only checked for duplicates within
-- staff_access_requests itself — it never checked whether the email
-- already belongs to an existing auth.users account (commuter or
-- staff). That request would sail through, get approved, and only then
-- fail at inviteUserByEmail() with "already registered" — the same
-- confusing failure class we saw testing the old flow, just surfacing
-- at approval time instead of request time.
--
-- Mirrors check_id_number_available (0017): a public, anon-callable,
-- read-only pre-check the frontend calls before submitting the form.
-- =====================================================================

create or replace function public.check_email_available_for_staff(p_email text)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select not exists (
    select 1 from auth.users u where lower(u.email) = lower(trim(p_email))
  );
$$;

grant execute on function public.check_email_available_for_staff(text) to anon, authenticated;