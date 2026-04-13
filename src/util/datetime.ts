/** Normalize any valid ISO-8601 datetime to canonical
 *  `YYYY-MM-DDTHH:MM:SS.sssZ` form. OpenStates returns microsecond
 *  precision with `+00:00` offsets which fail the strict Zod
 *  `iso.datetime()` regex used by `Document`; this is the chokepoint
 *  that keeps storage in canonical form regardless of source quirks. */
export function normalizeIsoDatetime(input: string): string {
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid datetime: ${JSON.stringify(input)}`);
  }
  return d.toISOString();
}
