import { describe, it, expect, afterEach } from "vitest";
import { buildServer } from "../../../src/state/server.js";

describe("civic-state-mcp server", () => {
  let server: ReturnType<typeof buildServer> | null = null;

  afterEach(() => {
    server?.store.close();
    server = null;
  });

  it("boots and registers exactly 8 tools", () => {
    server = buildServer({ dbPath: ":memory:" });
    const { mcp } = server;

    const tools = (mcp as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
    expect(Object.keys(tools)).toHaveLength(8);

    const expectedTools = [
      "recent_bills",
      "get_bill",
      "list_bills",
      "search_civic_documents",
      "search_entities",
      "resolve_person",
      "get_entity",
      "entity_connections",
    ];
    for (const name of expectedTools) {
      expect(tools, `tool ${name} should be registered`).toHaveProperty(name);
    }
  });

  it("does NOT register federal-only tools", () => {
    server = buildServer({ dbPath: ":memory:" });
    const tools = (server.mcp as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;

    expect(tools).not.toHaveProperty("recent_votes");
    expect(tools).not.toHaveProperty("recent_contributions");
    expect(tools).not.toHaveProperty("get_vote");
  });
});
