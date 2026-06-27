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

-- Populate a profile row whenever a new user signs up.
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

-- Creators and members can read their rooms.
CREATE POLICY "Members and creators can view rooms"
  ON rooms FOR SELECT TO authenticated
  USING (
    created_by = auth.uid()
    OR id IN (SELECT room_id FROM room_members WHERE user_id = auth.uid())
  );

-- ─── room_members ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS room_members (
  room_id   uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  joined_at timestamptz DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);

ALTER TABLE room_members ENABLE ROW LEVEL SECURITY;

-- Members can see all members of any room they belong to.
CREATE POLICY "Members can view their room membership"
  ON room_members FOR SELECT TO authenticated
  USING (
    room_id IN (
      SELECT rm2.room_id FROM room_members rm2 WHERE rm2.user_id = auth.uid()
    )
  );

-- ─── SECURITY DEFINER helpers ─────────────────────────────────────────────────
-- These run as the DB owner to bypass RLS for the create/join flows, where a
-- user needs to insert a room before they are yet listed as a member of it.

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
-- Schema only — no UI in Stage 0.

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
-- Schema only — no UI in Stage 0.

CREATE TABLE IF NOT EXISTS session_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  type       text NOT NULL,
  content    text,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE session_events ENABLE ROW LEVEL SECURITY;
