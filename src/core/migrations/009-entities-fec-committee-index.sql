-- Phase 9.1 D2: expression index on external_ids."fec_committee"
-- Hot path: every OpenFEC committee filing upsert.
CREATE INDEX IF NOT EXISTS idx_entities_fec_committee
  ON entities(json_extract(external_ids, '$."fec_committee"'));
