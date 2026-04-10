-- ═══════════════════════════════════════════════════════════════
-- Kenoki — Intelligence Layer Migration
-- Run once in Supabase SQL editor: https://supabase.com/dashboard
-- ═══════════════════════════════════════════════════════════════

-- 1. Extensions (likely already enabled on Supabase free tier)
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 2. Embedding column on people (384-dim, matches all-MiniLM-L6-v2)
ALTER TABLE people ADD COLUMN IF NOT EXISTS embedding vector(384);

-- 3. Inferred edges — separate from user's explicit relationships
CREATE TABLE IF NOT EXISTS inferred_edges (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     uuid REFERENCES auth.users NOT NULL,
  person_a_id uuid REFERENCES people(id) ON DELETE CASCADE NOT NULL,
  person_b_id uuid REFERENCES people(id) ON DELETE CASCADE NOT NULL,
  edge_type   text NOT NULL,  -- 'co-worker' | 'same-role' | 'same-industry'
  strength    numeric(3,2) NOT NULL DEFAULT 0.5,
  created_at  timestamptz DEFAULT now(),
  UNIQUE(user_id, person_a_id, person_b_id)
);

ALTER TABLE inferred_edges ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users own inferred edges"
  ON inferred_edges FOR ALL
  USING (auth.uid() = user_id);

-- 4. Indexes
CREATE INDEX IF NOT EXISTS people_embedding_idx
  ON people USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE INDEX IF NOT EXISTS people_role_trgm_idx
  ON people USING gin (role gin_trgm_ops);

CREATE INDEX IF NOT EXISTS inferred_edges_user_idx
  ON inferred_edges(user_id);

-- 5. Inference RPC — called after every import, runs entirely in the DB
--    Generates: co-worker edges, fuzzy role-match edges, same-industry edges
CREATE OR REPLACE FUNCTION run_inference(p_user_id uuid)
RETURNS jsonb AS $$
DECLARE
  co_count   int;
  role_count int;
  ind_count  int;
BEGIN
  -- Full refresh: delete previous inferred edges for this user
  DELETE FROM inferred_edges WHERE user_id = p_user_id;

  -- ── Co-worker: same company_id ──────────────────────────────
  INSERT INTO inferred_edges (user_id, person_a_id, person_b_id, edge_type, strength)
  SELECT p_user_id, p1.id, p2.id, 'co-worker', 0.7
  FROM people p1
  JOIN people p2
    ON  p1.company_id = p2.company_id
    AND p1.id < p2.id
    AND p1.company_id IS NOT NULL
  WHERE p1.user_id = p_user_id
    AND p2.user_id = p_user_id
  ON CONFLICT (user_id, person_a_id, person_b_id) DO NOTHING;
  GET DIAGNOSTICS co_count = ROW_COUNT;

  -- ── Same role cluster: pg_trgm fuzzy match > 0.5 ────────────
  INSERT INTO inferred_edges (user_id, person_a_id, person_b_id, edge_type, strength)
  SELECT p_user_id, p1.id, p2.id, 'same-role',
    ROUND(similarity(p1.role, p2.role)::numeric, 2)
  FROM people p1
  JOIN people p2
    ON  p1.id < p2.id
    AND p1.role IS NOT NULL
    AND p2.role IS NOT NULL
    AND similarity(p1.role, p2.role) > 0.5
  WHERE p1.user_id = p_user_id
    AND p2.user_id = p_user_id
  ON CONFLICT (user_id, person_a_id, person_b_id) DO NOTHING;
  GET DIAGNOSTICS role_count = ROW_COUNT;

  -- ── Same industry: exact match, different companies ──────────
  INSERT INTO inferred_edges (user_id, person_a_id, person_b_id, edge_type, strength)
  SELECT p_user_id, p1.id, p2.id, 'same-industry', 0.4
  FROM people p1
  JOIN people p2
    ON  p1.id < p2.id
    AND lower(p1.industry) = lower(p2.industry)
    AND p1.industry IS NOT NULL
    AND p1.company_id IS DISTINCT FROM p2.company_id
  WHERE p1.user_id = p_user_id
    AND p2.user_id = p_user_id
  ON CONFLICT (user_id, person_a_id, person_b_id) DO NOTHING;
  GET DIAGNOSTICS ind_count = ROW_COUNT;

  RETURN jsonb_build_object(
    'co_worker',     co_count,
    'same_role',     role_count,
    'same_industry', ind_count,
    'total',         co_count + role_count + ind_count
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 6. Vector similarity search RPC — used by command palette
CREATE OR REPLACE FUNCTION search_similar(
  query_embedding vector(384),
  p_user_id       uuid,
  match_count     int DEFAULT 20
)
RETURNS TABLE(id uuid, full_name text, role text, company_id uuid, similarity float)
AS $$
  SELECT
    p.id,
    p.full_name,
    p.role,
    p.company_id,
    (1 - (p.embedding <=> query_embedding))::float AS similarity
  FROM people p
  WHERE p.user_id = p_user_id
    AND p.embedding IS NOT NULL
  ORDER BY p.embedding <=> query_embedding
  LIMIT match_count;
$$ LANGUAGE sql;
