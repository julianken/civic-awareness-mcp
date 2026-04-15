/** Masks secrets that callers may inadvertently include in log
 *  messages or URLs. Covers: `?api_key=…` / `&api_key=…` query
 *  params, `X-API-KEY: …` header values, and UUIDs (which are
 *  often sensitive identifiers in our domain — entity IDs,
 *  document IDs). Conservative: only redacts known patterns,
 *  never strips structure. */
export function redactSecrets(msg: string): string {
  return msg
    .replace(/([?&])api_key=[^&\s"']+/gi, "$1api_key=***REDACTED***")
    .replace(/X-API-KEY["'\s:]+[A-Za-z0-9-]+/gi, "X-API-KEY: ***REDACTED***")
    .replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, "***UUID***");
}
