import { describe, it, expect } from "vitest";
import { buildServer } from "../../../src/mcp/server.js";

describe("buildServer", () => {
  it("constructs an MCP server with no tools registered yet", () => {
    const { mcp, store } = buildServer({ dbPath: ":memory:" });
    expect(mcp).toBeDefined();
    expect(store).toBeDefined();
    store.close();
  });

  it("registers the get_bill tool", () => {
    const { mcp, store } = buildServer({ dbPath: ":memory:" });
    const tools = (mcp as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools;
    expect(tools).toHaveProperty("get_bill");
    store.close();
  });
});
