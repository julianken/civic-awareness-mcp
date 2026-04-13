# Example 1 — `recent_votes`

Pull the last two weeks of federal roll-call votes in the upper chamber.

## Request

```json
{
  "jurisdiction": "us-federal",
  "days": 14,
  "chamber": "upper"
}
```

## Response (trimmed to 3 of 22 results)

```json
{
  "results": [
    {
      "id": "vote-01J8K...",
      "bill_identifier": "S.1421",
      "chamber": "upper",
      "date": "2026-04-10",
      "result": "passed",
      "tally": { "yea": 68, "nay": 31, "present": 0, "absent": 1 },
      "source_url": "https://www.congress.gov/bill/119th-congress/senate-bill/1421/all-actions?q=%7B%22roll-call-vote%22%3A%22true%22%7D"
    },
    {
      "id": "vote-01J8L...",
      "bill_identifier": "S.Amdt.2104",
      "chamber": "upper",
      "date": "2026-04-08",
      "result": "agreed to",
      "tally": { "yea": 51, "nay": 49, "present": 0, "absent": 0 },
      "source_url": "https://www.congress.gov/amendment/119th-congress/senate-amendment/2104"
    },
    {
      "id": "vote-01J8M...",
      "bill_identifier": "H.R.892",
      "chamber": "upper",
      "date": "2026-04-02",
      "result": "failed",
      "tally": { "yea": 48, "nay": 52, "present": 0, "absent": 0 },
      "source_url": "https://www.congress.gov/bill/119th-congress/house-bill/892"
    }
  ],
  "total": 22,
  "sources": [
    { "name": "congress.gov", "url": "https://api.congress.gov/v3" }
  ],
  "window": { "from": "2026-03-30", "to": "2026-04-13" }
}
```

## Notes

- `result` is verbatim from upstream Congress.gov rather than a normalized enum — the specific verbs (`"passed"`, `"failed"`, `"agreed to"`, `"rejected"`, etc.) are the authoritative language the chamber records use.
- `tally.absent` counts Members not voting for any reason (including pairs and announced positions). The original motion/amendment classification stays in `bill_identifier` — amendments surface with `S.Amdt.` / `H.Amdt.` prefixes.
- State-level votes from OpenStates follow the exact same shape. Switching `jurisdiction` to `"us-tx"` would return Texas roll calls instead, with `source_url`s pointing at the OpenStates vote page.
