-- ═══════════════════════════════════════════════════════════════
-- Kenoki — Intelligence Layer v2 Migration
-- Enables multi-dimensional edges: same person pair can have
-- co-worker + same-role + semantic-similar simultaneously.
-- Run once in Supabase SQL editor after migration.sql.
-- ═══════════════════════════════════════════════════════════════

-- 1. Fix UNIQUE constraint — allow multiple edge types per pair
--    Old: UNIQUE(user_id, person_a_id, person_b_id)        ← one edge max per pair
--    New: UNIQUE(user_id, person_a_id, person_b_id, edge_type) ← spider/web graph

ALTER TABLE inferred_edges
  DROP CONSTRAINT IF EXISTS inferred_edges_user_id_person_a_id_person_b_id_key;

ALTER TABLE inferred_edges
  ADD CONSTRAINT inferred_edges_unique_per_type
  UNIQUE(user_id, person_a_id, person_b_id, edge_type);

-- 2. Add dirty_data flag to people — set by anomaly detection
ALTER TABLE people ADD COLUMN IF NOT EXISTS dirty_data_flags jsonb DEFAULT '{}';

-- 3. Heuristics function — marks people with likely data-entry errors
--    Runs cheap pattern matching, no LLM required
CREATE OR REPLACE FUNCTION flag_dirty_data(p_user_id uuid)
RETURNS int AS $$
DECLARE
  flagged int := 0;
BEGIN
  -- full_name looks like a company (contains legal suffix)
  UPDATE people SET dirty_data_flags = dirty_data_flags || '{"name_is_company": true}'
  WHERE user_id = p_user_id
    AND (
      full_name ILIKE '%inc%'    OR full_name ILIKE '%ltd%'    OR
      full_name ILIKE '%llc%'    OR full_name ILIKE '%corp%'   OR
      full_name ILIKE '%group%'  OR full_name ILIKE '%holdings%' OR
      full_name ILIKE '%& co%'   OR full_name ILIKE '% co.'   OR
      full_name ILIKE '%gmbh%'   OR full_name ILIKE '%s.a.%'  OR
      full_name ILIKE '%pty%'    OR full_name ILIKE '%plc%'   OR
      full_name ILIKE '%limited%'
    )
    AND (dirty_data_flags->>'name_is_company' IS NULL);
  GET DIAGNOSTICS flagged = ROW_COUNT;

  -- role field looks like a company name (longer than 40 chars, or contains legal suffix)
  UPDATE people SET dirty_data_flags = dirty_data_flags || '{"role_is_company": true}'
  WHERE user_id = p_user_id
    AND role IS NOT NULL
    AND (
      LENGTH(role) > 40 OR
      role ILIKE '%inc%'  OR role ILIKE '%ltd%' OR
      role ILIKE '%llc%'  OR role ILIKE '%corp%'
    )
    AND (dirty_data_flags->>'role_is_company' IS NULL);

  RETURN flagged;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. Multi-dimensional run_inference — replaces v1
--    Now generates 4 edge types independently per pair:
--      co-worker       (same company_id, strength 0.7)
--      same-role       (pg_trgm fuzzy match > 0.80, strength = similarity score)
--      same-industry   (exact industry match, different companies, strength 0.4)
--      semantic-similar (pgvector cosine sim > 0.75, KNN top-10 per person)
--
--    Because UNIQUE is now per (user, a, b, type), a Captain can simultaneously
--    connect to another Captain via same-role AND to a maritime professional via
--    same-industry AND to a similar-profile person via semantic-similar.
--    That is the spider/web graph.

CREATE OR REPLACE FUNCTION run_inference(p_user_id uuid)
RETURNS jsonb AS $$
DECLARE
  co_count   int;
  role_count int;
  ind_count  int;
  sem_count  int;
BEGIN
  -- Full refresh: wipe all inferred edges for this user
  DELETE FROM inferred_edges WHERE user_id = p_user_id;

  -- ── Co-worker: same company_id ──────────────────────────────────
  INSERT INTO inferred_edges (user_id, person_a_id, person_b_id, edge_type, strength)
  SELECT p_user_id, p1.id, p2.id, 'co-worker', 0.7
  FROM people p1
  JOIN people p2
    ON  p1.company_id = p2.company_id
    AND p1.id < p2.id
    AND p1.company_id IS NOT NULL
  WHERE p1.user_id = p_user_id
    AND p2.user_id = p_user_id
  ON CONFLICT (user_id, person_a_id, person_b_id, edge_type) DO NOTHING;
  GET DIAGNOSTICS co_count = ROW_COUNT;

  -- ── Same-role: pg_trgm fuzzy match (threshold 0.80 avoids false positives) ──
  INSERT INTO inferred_edges (user_id, person_a_id, person_b_id, edge_type, strength)
  SELECT p_user_id, p1.id, p2.id, 'same-role',
    ROUND(similarity(p1.role, p2.role)::numeric, 2)
  FROM people p1
  JOIN people p2
    ON  p1.id < p2.id
    AND p1.role IS NOT NULL
    AND p2.role IS NOT NULL
    AND similarity(p1.role, p2.role) > 0.80
  WHERE p1.user_id = p_user_id
    AND p2.user_id = p_user_id
  ON CONFLICT (user_id, person_a_id, person_b_id, edge_type) DO NOTHING;
  GET DIAGNOSTICS role_count = ROW_COUNT;

  -- ── Same-industry: exact match, different companies ──────────────
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
  ON CONFLICT (user_id, person_a_id, person_b_id, edge_type) DO NOTHING;
  GET DIAGNOSTICS ind_count = ROW_COUNT;

  -- ── Semantic-similar: pgvector cosine similarity, KNN top-10 per person ──
  --    Only runs when embeddings exist (embedding IS NOT NULL).
  --    KNN approach: O(N × K × index_scan) not O(N²) — fast with IVFFlat index.
  --    Threshold 0.75: yields 2-20 connections per person, not an explosion.
  --    Deduplication via LEAST/GREATEST ensures (a,b) canonical ordering.
  INSERT INTO inferred_edges (user_id, person_a_id, person_b_id, edge_type, strength)
  SELECT DISTINCT ON (LEAST(p1_id, p2_id), GREATEST(p1_id, p2_id))
    p_user_id,
    LEAST(p1_id, p2_id),
    GREATEST(p1_id, p2_id),
    'semantic-similar',
    ROUND(sim::numeric, 2)
  FROM (
    SELECT
      p1.id                                        AS p1_id,
      nn.id                                        AS p2_id,
      (1 - (p1.embedding <=> nn.embedding))::float AS sim
    FROM people p1
    CROSS JOIN LATERAL (
      -- IVFFlat index makes this fast: ~O(sqrt(N)) per probe
      SELECT p2.id, p2.embedding
      FROM people p2
      WHERE p2.user_id = p_user_id
        AND p2.id != p1.id
        AND p2.embedding IS NOT NULL
      ORDER BY p1.embedding <=> p2.embedding
      LIMIT 10
    ) nn
    WHERE p1.user_id    = p_user_id
      AND p1.embedding IS NOT NULL
      AND (1 - (p1.embedding <=> nn.embedding)) > 0.75
  ) pairs
  ON CONFLICT (user_id, person_a_id, person_b_id, edge_type) DO NOTHING;
  GET DIAGNOSTICS sem_count = ROW_COUNT;

  RETURN jsonb_build_object(
    'co_worker',        co_count,
    'same_role',        role_count,
    'same_industry',    ind_count,
    'semantic_similar', sem_count,
    'total',            co_count + role_count + ind_count + sem_count
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 5. Grant execute on new function
GRANT EXECUTE ON FUNCTION flag_dirty_data(uuid) TO authenticated;

-- Done. Run SELECT run_inference('<your-user-id>') to verify.
-- The semantic_similar count will be 0 until embeddings are populated.
-- Open the app — the embedding worker will start computing vectors in the background.
-- Once complete, run inference again to pick up semantic edges.
