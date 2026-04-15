-- Expression index on the bioguide external-ID. The existing
-- idx_entities_ext_ids is on the raw external_ids JSON text and
-- doesn't help json_extract(external_ids, '$."bioguide"') lookups,
-- which are the hot path for per-legislator entity resolution in
-- get_vote and congress bill-sponsor upserts. The path literal
-- must match the call sites exactly for the planner to use the
-- index, so we keep the quoted '$."bioguide"' form.
CREATE INDEX IF NOT EXISTS idx_entities_bioguide
  ON entities(json_extract(external_ids, '$."bioguide"'));
