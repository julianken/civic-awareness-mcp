import type Database from "better-sqlite3";

// All 50 US states + D.C. for the state-mcp jurisdiction roster.
// Keep in sync with seedJurisdictions's expected count (51 rows).
const JURISDICTIONS = [
  { id: "us-al", level: "state", name: "Alabama" },
  { id: "us-ak", level: "state", name: "Alaska" },
  { id: "us-az", level: "state", name: "Arizona" },
  { id: "us-ar", level: "state", name: "Arkansas" },
  { id: "us-ca", level: "state", name: "California" },
  { id: "us-co", level: "state", name: "Colorado" },
  { id: "us-ct", level: "state", name: "Connecticut" },
  { id: "us-de", level: "state", name: "Delaware" },
  { id: "us-fl", level: "state", name: "Florida" },
  { id: "us-ga", level: "state", name: "Georgia" },
  { id: "us-hi", level: "state", name: "Hawaii" },
  { id: "us-id", level: "state", name: "Idaho" },
  { id: "us-il", level: "state", name: "Illinois" },
  { id: "us-in", level: "state", name: "Indiana" },
  { id: "us-ia", level: "state", name: "Iowa" },
  { id: "us-ks", level: "state", name: "Kansas" },
  { id: "us-ky", level: "state", name: "Kentucky" },
  { id: "us-la", level: "state", name: "Louisiana" },
  { id: "us-me", level: "state", name: "Maine" },
  { id: "us-md", level: "state", name: "Maryland" },
  { id: "us-ma", level: "state", name: "Massachusetts" },
  { id: "us-mi", level: "state", name: "Michigan" },
  { id: "us-mn", level: "state", name: "Minnesota" },
  { id: "us-ms", level: "state", name: "Mississippi" },
  { id: "us-mo", level: "state", name: "Missouri" },
  { id: "us-mt", level: "state", name: "Montana" },
  { id: "us-ne", level: "state", name: "Nebraska" },
  { id: "us-nv", level: "state", name: "Nevada" },
  { id: "us-nh", level: "state", name: "New Hampshire" },
  { id: "us-nj", level: "state", name: "New Jersey" },
  { id: "us-nm", level: "state", name: "New Mexico" },
  { id: "us-ny", level: "state", name: "New York" },
  { id: "us-nc", level: "state", name: "North Carolina" },
  { id: "us-nd", level: "state", name: "North Dakota" },
  { id: "us-oh", level: "state", name: "Ohio" },
  { id: "us-ok", level: "state", name: "Oklahoma" },
  { id: "us-or", level: "state", name: "Oregon" },
  { id: "us-pa", level: "state", name: "Pennsylvania" },
  { id: "us-ri", level: "state", name: "Rhode Island" },
  { id: "us-sc", level: "state", name: "South Carolina" },
  { id: "us-sd", level: "state", name: "South Dakota" },
  { id: "us-tn", level: "state", name: "Tennessee" },
  { id: "us-tx", level: "state", name: "Texas" },
  { id: "us-ut", level: "state", name: "Utah" },
  { id: "us-vt", level: "state", name: "Vermont" },
  { id: "us-va", level: "state", name: "Virginia" },
  { id: "us-wa", level: "state", name: "Washington" },
  { id: "us-wv", level: "state", name: "West Virginia" },
  { id: "us-wi", level: "state", name: "Wisconsin" },
  { id: "us-wy", level: "state", name: "Wyoming" },
  { id: "us-dc", level: "state", name: "District of Columbia" },
];

export function seedJurisdictions(db: Database.Database): void {
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO jurisdictions (id, level, name) VALUES (?, ?, ?)",
  );
  for (const j of JURISDICTIONS) stmt.run(j.id, j.level, j.name);
}
