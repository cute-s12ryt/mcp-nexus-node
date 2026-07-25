import { existsSync } from "node:fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

describe("stdio MCP server", () => {
  it("initializes, lists tools, and calls search_index from TypeScript source", async () => {
    await verifyStdioServer(["--import", "tsx", "src/server.ts"]);
  }, 15_000);

  it.runIf(existsSync("dist/server.js"))("initializes, lists tools, and calls search_index from compiled JavaScript", async () => {
    await verifyStdioServer(["dist/server.js"]);
  }, 15_000);
});

async function verifyStdioServer(args: string[]): Promise<void> {
    const client = new Client({ name: "integration-test", version: "0.1.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args,
      cwd: process.cwd(),
    });

    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        "search_index",
        "get_document",
      ]);

      const result = await client.callTool({
        name: "search_index",
        arguments: { query: "controlled", limit: 5 },
      });
      expect(result.isError).not.toBe(true);
      expect(result.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "text" }),
        ]),
      );
    } finally {
      await client.close();
    }
}
