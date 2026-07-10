-- Tandem — initial schema
-- Run this in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- Tables are ordered by dependency (no forward refs).

-- ─── profiles ────────────────────────────────────────────────────────────────
-- Shadow table for auth.users so server components can JOIN email into room
-- queries without needing the service role key.

CREATE TABLE IF NOT EXISTS profiles (
  id         uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email      text NOT NULL,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read profiles"
  ON profiles FOR SELECT TO authenticated USING (true);

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, email)
  VALUES (NEW.id, NEW.email)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ─── rooms ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rooms (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_by  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  invite_code text NOT NULL UNIQUE,
  created_at  timestamptz DEFAULT now()
);

ALTER TABLE rooms ENABLE ROW LEVEL SECURITY;

-- ─── room_members ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS room_members (
  room_id   uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  joined_at timestamptz DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);

ALTER TABLE room_members ENABLE ROW LEVEL SECURITY;

-- Membership check used by RLS policies. Must be SECURITY DEFINER so its
-- internal read of room_members runs as the table owner (RLS-exempt) rather
-- than re-triggering room_members' own SELECT policy — otherwise the policy
-- referencing room_members from within room_members causes Postgres error
-- 42P17 "infinite recursion detected in policy for relation room_members".
CREATE OR REPLACE FUNCTION is_room_member(p_room_id uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.room_members
    WHERE room_id = p_room_id AND user_id = auth.uid()
  );
$$;

-- Members can see all members of any room they belong to.
DROP POLICY IF EXISTS "Members can view their room membership" ON room_members;
CREATE POLICY "Members can view their room membership"
  ON room_members FOR SELECT TO authenticated
  USING ( is_room_member(room_id) );

-- Now that room_members exists, we can create the rooms SELECT policy.
DROP POLICY IF EXISTS "Members and creators can view rooms" ON rooms;
CREATE POLICY "Members and creators can view rooms"
  ON rooms FOR SELECT TO authenticated
  USING (
    created_by = auth.uid()
    OR is_room_member(id)
  );

-- ─── SECURITY DEFINER helpers ─────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION create_room(p_name text, p_invite_code text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_room_id uuid;
BEGIN
  INSERT INTO public.rooms (name, created_by, invite_code)
  VALUES (p_name, auth.uid(), p_invite_code)
  RETURNING id INTO v_room_id;

  INSERT INTO public.room_members (room_id, user_id)
  VALUES (v_room_id, auth.uid());

  RETURN v_room_id;
END;
$$;

CREATE OR REPLACE FUNCTION join_room_by_invite_code(p_invite_code text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_room_id uuid;
BEGIN
  SELECT id INTO v_room_id
  FROM public.rooms
  WHERE invite_code = p_invite_code;

  IF v_room_id IS NULL THEN
    RAISE EXCEPTION 'Room not found';
  END IF;

  INSERT INTO public.room_members (room_id, user_id)
  VALUES (v_room_id, auth.uid())
  ON CONFLICT (room_id, user_id) DO NOTHING;

  RETURN v_room_id;
END;
$$;

-- ─── sessions ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id           uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  parent_session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  status            text NOT NULL DEFAULT 'active',
  started_at        timestamptz DEFAULT now(),
  ended_at          timestamptz
);

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;

-- ─── session_events ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS session_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  type       text NOT NULL,
  content    text,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE session_events ENABLE ROW LEVEL SECURITY;

-- Room members can read session history (Stage 4 late-joiner backfill:
-- tandem-web renders durable history when Liveblocks storage is missing it).
-- Writes stay exclusive to tandem-server's service role.
DROP POLICY IF EXISTS "Members can view sessions in their rooms" ON sessions;
CREATE POLICY "Members can view sessions in their rooms"
  ON sessions FOR SELECT TO authenticated
  USING ( is_room_member(room_id) );

DROP POLICY IF EXISTS "Members can view session events in their rooms" ON session_events;
CREATE POLICY "Members can view session events in their rooms"
  ON session_events FOR SELECT TO authenticated
  USING (
    session_id IN (SELECT id FROM public.sessions WHERE is_room_member(room_id))
  );

-- ─── grants ──────────────────────────────────────────────────────────────────
-- Postgres checks table-level privileges BEFORE row-level security. Without
-- these grants every query fails with 42501 "permission denied for table",
-- regardless of RLS policies. RLS still controls which rows are visible.
-- Reads are SELECT-only for authenticated; all writes go through the
-- SECURITY DEFINER functions above, so no INSERT/UPDATE/DELETE grants needed.

GRANT USAGE ON SCHEMA public TO authenticated, service_role;
GRANT SELECT ON public.profiles, public.rooms, public.room_members,
  public.sessions, public.session_events TO authenticated;

-- tandem-server (Stage 2+) uses the service role key, which bypasses RLS but
-- still needs table privileges.
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
