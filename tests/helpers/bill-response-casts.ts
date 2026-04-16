/** Test helper for the federal bill-listing tool's discriminated-union
 *  return type. The cast is unsafe in the general case — only call
 *  this from sites where the precondition holds (no `limit` or
 *  `limit ≤ 500`). */

import type Database from "better-sqlite3";
import {
  handleRecentBills,
  type RecentBillsResponse,
} from "../../src/federal/tools/recent_bills.js";

export async function callBills(
  db: Database.Database,
  input: Parameters<typeof handleRecentBills>[1],
): Promise<RecentBillsResponse> {
  return handleRecentBills(db, input) as Promise<RecentBillsResponse>;
}
