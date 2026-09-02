/*
# Add usage_events table and plan limits

1. New Tables
- `usage_events` — tracks each AI generation, build, and deploy event per user
  - `id` (uuid, primary key)
  - `user_id` (uuid, not null, defaults to auth.uid(), references auth.users with cascade delete)
  - `event_type` (text, not null) — 'generation' | 'build' | 'deploy'
  - `tokens_used` (integer, nullable) — token count for AI generation events
  - `model` (text, nullable) — which AI model was used
  - `project_id` (uuid, nullable, references projects with cascade delete)
  - `created_at` (timestamptz, default now())

2. Security
- Enable RLS on `usage_events`.
- Owner-scoped CRUD: each authenticated user can only insert/read their own usage events.
- INSERT policy with WITH CHECK (auth.uid() = user_id) so only the authenticated user can create events for themselves.
- SELECT policy scoped to auth.uid() = user_id.
- No UPDATE or DELETE policies needed (usage events are append-only audit records).

3. Indexes
- Index on (user_id, event_type, created_at) for fast monthly count queries.
- Index on (user_id, created_at) for general user activity lookups.

4. Important Notes
- The `user_id` column has `DEFAULT auth.uid()` so frontend inserts that omit user_id still satisfy the INSERT policy.
- Usage limits are enforced in the frontend by querying count of 'generation' events in the current month.
- Free tier: 5 generations/month, Pro tier: 100/month. These limits live in application code, not the database.
*/

CREATE TABLE IF NOT EXISTS usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  tokens_used integer,
  model text,
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_usage_events" ON usage_events;
CREATE POLICY "select_own_usage_events"
ON usage_events FOR SELECT
TO authenticated USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "insert_own_usage_events" ON usage_events;
CREATE POLICY "insert_own_usage_events"
ON usage_events FOR INSERT
TO authenticated WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_usage_events_user_type_created
ON usage_events (user_id, event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_usage_events_user_created
ON usage_events (user_id, created_at DESC);
