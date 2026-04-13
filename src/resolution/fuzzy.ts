export function normalizeName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

export interface FuzzyCandidate {
  id: string;
  name: string;
  /** External-ID source families this candidate already has an ID in
   *  (e.g. "openstates_person", "bioguide", "fec_candidate"). */
  external_id_sources: string[];
  /** Any known aliases, used for middle-name/initial linking. */
  aliases: string[];
  /** Jurisdictions appearing in this candidate's metadata.roles[]. */
  role_jurisdictions: string[];
}

/** Information about the upstream record whose identity we're trying
 *  to resolve. At least one field must overlap with a candidate for
 *  fuzzyPick to return it (D3b linking-signal requirement). */
export interface UpstreamSignals {
  external_id_sources: string[];
  /** Middle name or initial from the upstream record, if present. */
  middle_name: string | null;
  /** Jurisdictions associated with the upstream record (e.g. the
   *  jurisdiction of the document referencing this entity). */
  role_jurisdictions: string[];
}

// D3b: tightened from ≤ 2 to ≤ 1 to compensate for nationwide name
// collision risk under the US-federal + 50-state scope.
const ACCEPT_DISTANCE = 1;
const RUNNER_UP_MIN_DISTANCE = 3;

function hasLinkingSignal(c: FuzzyCandidate, s: UpstreamSignals): boolean {
  // Shared external_id source family.
  for (const src of s.external_id_sources) {
    if (c.external_id_sources.includes(src)) return true;
  }
  // Middle name/initial matches an alias token.
  if (s.middle_name) {
    const needle = s.middle_name.toLowerCase().replace(/\./g, "");
    for (const alias of c.aliases) {
      if (normalizeName(alias).split(" ").includes(needle)) return true;
    }
  }
  // Role-jurisdiction overlap.
  for (const j of s.role_jurisdictions) {
    if (c.role_jurisdictions.includes(j)) return true;
  }
  return false;
}

export function fuzzyPick<T extends FuzzyCandidate>(
  query: string,
  signals: UpstreamSignals,
  candidates: T[],
): T | null {
  const q = normalizeName(query);
  const scored = candidates
    .map((c) => ({ c, d: levenshtein(q, normalizeName(c.name)) }))
    .sort((a, b) => a.d - b.d);
  if (scored.length === 0) return null;
  const best = scored[0];
  if (best.d > ACCEPT_DISTANCE) return null;
  const runnerUp = scored[1];
  if (runnerUp && runnerUp.d < RUNNER_UP_MIN_DISTANCE) return null;
  if (!hasLinkingSignal(best.c, signals)) return null;
  return best.c;
}
