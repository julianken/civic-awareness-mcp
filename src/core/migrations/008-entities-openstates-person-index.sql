-- Phase 9.1 D1: expression index on external_ids."openstates_person"
-- Hot path: every OpenStates sponsor upsert. Same path-quote
-- convention as 007 (idx_entities_bioguide); see entities.ts helper
-- for the canonical constant.
CREATE INDEX IF NOT EXISTS idx_entities_openstates_person
  ON entities(json_extract(external_ids, '$."openstates_person"'));
