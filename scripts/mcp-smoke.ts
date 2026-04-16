import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type SmokeTarget = {
  label: string;
  args: string[];
  env: Record<string, string>;
  expectedTools: string[];
};

function repoRoot(): string {
  const __filename = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(__filename), "..");
}

async function smoke(target: SmokeTarget): Promise<void> {
  const transport = new StdioClientTransport({
    command: "node",
    args: target.args,
    env: { ...process.env, ...target.env },
    stderr: "pipe",
    cwd: repoRoot(),
  });

  const client = new Client({ name: "civic-awareness-ci", version: "0.0.0" });
  await client.connect(transport);

  const tools = await client.listTools();
  const toolNames = new Set(tools.tools.map((t) => t.name));
  const expected = new Set(target.expectedTools);

  const missing = target.expectedTools.filter((t) => !toolNames.has(t));
  const unexpected = [...toolNames].filter((t) => !expected.has(t));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `[${target.label}] tool set mismatch. missing=[${missing.join(", ")}] unexpected=[${unexpected.join(", ")}]`,
    );
  }

  await client.close();
}

async function main(): Promise<void> {
  const root = repoRoot();
  const dataDir = path.join(root, "data");

  const targets: SmokeTarget[] = [
    {
      label: "federal",
      args: ["dist/federal/index.js"],
      env: {
        CIVIC_FEDERAL_DB_PATH: path.join(dataDir, "ci-federal.db"),
      },
      expectedTools: [
        "recent_bills",
        "recent_votes",
        "recent_contributions",
        "search_entities",
        "get_entity",
        "search_civic_documents",
        "entity_connections",
        "resolve_person",
        "get_vote",
      ],
    },
    {
      label: "state",
      args: ["dist/state/index.js"],
      env: {
        CIVIC_STATE_DB_PATH: path.join(dataDir, "ci-state.db"),
      },
      expectedTools: [
        "recent_bills",
        "get_bill",
        "search_civic_documents",
        "search_entities",
        "resolve_person",
        "get_entity",
        "entity_connections",
        "recent_votes",
      ],
    },
  ];

  for (const t of targets) {
    await smoke(t);
  }
}

main().catch((err) => {
  console.error(String(err));
  process.exitCode = 1;
});
