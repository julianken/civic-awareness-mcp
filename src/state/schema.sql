-- Expression index on external_ids."openstates_person" — hot path
-- for every OpenStates sponsor upsert. Path literal must match
-- the constant in src/state/entities.ts byte-for-byte.
CREATE INDEX IF NOT EXISTS idx_entities_openstates_person
  ON entities(json_extract(external_ids, '$."openstates_person"'));
