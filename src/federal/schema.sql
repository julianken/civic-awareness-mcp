-- Expression index on the bioguide external-ID. Hot path for per-legislator
-- entity resolution in get_vote and congress bill-sponsor upserts.
CREATE INDEX IF NOT EXISTS idx_entities_bioguide
  ON entities(json_extract(external_ids, '$."bioguide"'));

-- Expression index on external_ids."fec_committee". Hot path for every
-- OpenFEC committee filing upsert.
CREATE INDEX IF NOT EXISTS idx_entities_fec_committee
  ON entities(json_extract(external_ids, '$."fec_committee"'));
