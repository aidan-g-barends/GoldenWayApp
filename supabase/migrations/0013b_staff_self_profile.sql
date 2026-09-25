-- =====================================================================
-- GoldenWay — migration 0013: staff self-service profile details
-- =====================================================================
--
-- Lets any active staff member (CLERK included) edit their own:
--   · first_name / surname
--   · phone (NEW column — mirrors commuters.phone, same format check)
--   · password — only after re-verifying the CURRENT password
--
-- Design:
--   · public.staff gains `phone text` (nullable; legacy rows are null
--     until the person saves their profile once).
--   · update happens through ONE security-definer RPC so the "current
--     password matches" rule can't be bypassed by writing the table
--     directly (RLS stays ADMIN-only for staff rows — no new policy).
--   · Password change: the RPC verifies `p_current_password` with pgcrypto
--     against auth.users.encrypted_password (bcrypt) — readable by the
--     postgres role this security-definer function runs as.
--   · staff_action_log entry for both detail edits and password changes.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. pgcrypto — Supabase puts it in the `extensions` schema; make sure
--    it exists there so crypt()/gen_salt() resolve inside the RPC.
-- ---------------------------------------------------------------------

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------
-- 1. phone column on staff
-- ---------------------------------------------------------------------

alter table public.staff
  add column if not exists phone text;

-- Same SA phone format the commuters table enforces.
alter table public.staff
  drop constraint if exists staff_phone_format;
alter table public.staff
  add constraint staff_phone_format
  check (phone is null or phone ~ '^(\+27|0)\d{9}$');

-- ---------------------------------------------------------------------
-- 2. The self-service RPC
-- ---------------------------------------------------------------------

-- Update my own staff profile.
--   p_current_password — required ONLY when changing the password.
--   p_new_password     — required when p_change_password is true.
-- Returns the refreshed profile row as json.
create or replace function public.update_my_staff_details(
  p_first_name        text,
  p_surname           text,
  p_phone             text,
  p_change_password   boolean default false,
  p_current_password  text default null,
  p_new_password      text default null
)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_uid      uuid := auth.uid();
  v_row      public.staff;
  v_pw_ok    boolean := false;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED' using errcode = '28000';
  end if;

  select * into v_row from public.staff where staff.id = v_uid;
  if v_row is null then
    raise exception 'NOT_STAFF' using errcode = '42501';
  end if;
  if not v_row.active then
    raise exception 'ACCOUNT_INACTIVE' using errcode = '42501';
  end if;

  -- Validate name inputs
  if p_first_name is null or btrim(p_first_name) = '' then
    raise exception 'First name is required' using errcode = '22023';
  end if;
  if p_surname is null or btrim(p_surname) = '' then
    raise exception 'Surname is required' using errcode = '22023';
  end if;

  -- Validate phone: either null or SA format
  if p_phone is not null
     and btrim(p_phone) <> ''
     and p_phone !~ '^(\+27|0)\d{9}$' then
    raise exception 'Phone must be a valid SA number, e.g. 0821234567' using errcode = '22023';
  end if;

  -- -----------------------------------------------------------------
  -- Password change path — verify the CURRENT password first.
  -- auth.users.encrypted_password is readable by the table owner
  -- (postgres), which this security-definer function runs as. Supabase
  -- stores bcrypt hashes, so compare with pgcrypto's crypt().
  -- -----------------------------------------------------------------
  if p_change_password then
    if coalesce(btrim(p_current_password), '') = '' then
      raise exception 'Enter your current password to change it' using errcode = '22023';
    end if;
    if coalesce(btrim(p_new_password), '') = '' then
      raise exception 'New password is required' using errcode = '22023';
    end if;
    if length(btrim(p_new_password)) < 8 then
      raise exception 'New password must be at least 8 characters' using errcode = '22023';
    end if;

    select crypt(p_current_password, encrypted_password) = encrypted_password
      into v_pw_ok
      from auth.users
      where id = v_uid;

    if v_pw_ok is not true then
      raise exception 'Current password is incorrect' using errcode = '22023';
    end if;
  end if;

  -- -----------------------------------------------------------------
  -- Apply the profile edits
  -- -----------------------------------------------------------------
  update public.staff
    set first_name = btrim(p_first_name),
        surname    = btrim(p_surname),
        phone      = nullif(btrim(coalesce(p_phone, '')), '')
    where id = v_uid
    returning * into v_row;

  insert into public.staff_action_log (actor_id, action, entity, entity_id, details)
  values (v_uid, 'UPDATE_OWN_PROFILE', 'staff', v_uid::text,
          jsonb_build_object(
            'first_name', v_row.first_name,
            'surname',    v_row.surname,
            'password_changed', coalesce(p_change_password, false)));

  -- -----------------------------------------------------------------
  -- Apply the password change (after the log, so the log records the
  -- attempt that succeeded).
  -- -----------------------------------------------------------------
  if p_change_password then
    update auth.users
      set encrypted_password = crypt(p_new_password, gen_salt('bf', 10))
      where id = v_uid;
  end if;

  return json_build_object(
    'firstName', v_row.first_name,
    'surname',   v_row.surname,
    'phone',     v_row.phone,
    'email',     v_row.email,
    'role',      v_row.role,
    'passwordChanged', coalesce(p_change_password, false));
end;
$$;

grant execute on function public.update_my_staff_details(text, text, text, boolean, text, text)
  to authenticated;

-- ---------------------------------------------------------------------
-- 3. Read-your-own-phone helper (staff RLS lets a member read their own
--    row already, so the UI can just select phone from staff; no extra
--    RPC needed — but keep my_profile_type() in sync with the new field
--    so login/refresh carries it too).
-- ---------------------------------------------------------------------

create or replace function public.my_profile_type()
returns json
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_staff public.staff;
begin
  if auth.uid() is null then
    return null;
  end if;
  select * into v_staff from public.staff where staff.id = auth.uid();
  if v_staff is not null then
    return json_build_object(
      'userType', 'STAFF', 'role', v_staff.role, 'active', v_staff.active,
      'firstName', v_staff.first_name, 'surname', v_staff.surname,
      'email', v_staff.email, 'phone', v_staff.phone);
  end if;
  if exists (select 1 from public.commuters where commuters.id = auth.uid()) then
    return json_build_object('userType', 'COMMUTER');
  end if;
  return json_build_object('userType', 'UNPROFILED');
end;
$$;

-- ---------------------------------------------------------------------
-- 4. Notes
--    · No new RLS policies: staff rows remain ADMIN-only for update;
--      the RPC is security definer and self-scopes to auth.uid().
--    · Direct bcrypt verification against auth.users works because the
--      function owner is the postgres role. If Supabase ever moves
--      password storage, switch this to a gotrue reauthentication call
--      from the client instead.
-- =====================================================================
