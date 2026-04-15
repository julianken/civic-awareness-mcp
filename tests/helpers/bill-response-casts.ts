/** Test helpers for the bill-listing tools' discriminated-union
 *  return types. Use these at call sites that are provably outside
 *  the high-cost gate path (i.e. the test passes no `limit` or
 *  `limit ≤ 500`), so the response can never be the
 *  `RequiresConfirmationResponse` envelope. The cast is unsafe in
 *  the general case — only call these from sites where the
 *  precondition holds. */

import type Database from "better-sqlite3";
import {
  handleRecentBills,
  type RecentBillsResponse,
} from "../../src/mcp/tools/recent_bills.js";
import {
  handleListBills,
  type ListBillsResponse,
} from "../../src/mcp/tools/list_bills.js";

export async function callBills(
  db: Database.Database,
  input: Parameters<typeof handleRecentBills>[1],
): Promise<RecentBillsResponse> {
  return handleRecentBills(db, input) as Promise<RecentBillsResponse>;
}

export async function callListBills(
  db: Database.Database,
  input: Parameters<typeof handleListBills>[1],
): Promise<ListBillsResponse> {
  return handleListBills(db, input) as Promise<ListBillsResponse>;
}
