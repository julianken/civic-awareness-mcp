/** Test helpers for the bill-listing tools' discriminated-union
 *  return types. The cast is unsafe in the general case — only call
 *  these from sites where the precondition holds (no `limit` or
 *  `limit ≤ 500`). */

import type Database from "better-sqlite3";
import {
  handleRecentBills,
  type RecentBillsResponse,
} from "../../src/federal/tools/recent_bills.js";
import { handleListBills, type ListBillsResponse } from "../../src/state/tools/list_bills.js";

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
