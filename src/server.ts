#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import type { SearchDocument } from "./domain.js";
import { InMemoryDocumentRepository } from "./repository.js";
import { SearchService } from "./search-service.js";

const seedDocuments: SearchDocument[] = [
  {
    id: "welcome",
    title: "Focused Search MCP",
    url: "https://example.invalid/docs/welcome",
    content:
      "Focused Search MCP exposes controlled document search to MCP clients. Replace the in-memory repository with an approved persistent index before production use.",
    fetchedAt: "2026-07-19T00:00:00.000Z",
  },
];

const searchService = new SearchService(new InMemoryDocumentRepository(seedDocuments));
const server = new McpServer({ name: "focused-search-mcp-node", version: "0.1.0" });

server.registerTool(
  "search_index",
  {
    description: "Search documents already present in the controlled index.",
    inputSchema: {
      query: z.string().trim().min(1).max(500),
      limit: z.number().int().min(1).max(20).default(10),
    },
  },
  async ({ query, limit }) => {
    const results = searchService.search(query, limit);
    return {
      content: [{ type: "text", text: JSON.stringify({ query, results }) }],
    };
  },
);

server.registerTool(
  "get_document",
  {
    description: "Read a document by its controlled index identifier.",
    inputSchema: {
      documentId: z.string().trim().min(1).max(200),
      maxCharacters: z.number().int().min(1).max(50_000).default(10_000),
    },
  },
  async ({ documentId, maxCharacters }) => {
    const document = searchService.getDocument(documentId, maxCharacters);
    if (!document) {
      return {
        isError: true,
        content: [{ type: "text", text: `Document not found: ${documentId}` }],
      };
    }

    return { content: [{ type: "text", text: JSON.stringify(document) }] };
  },
);

await server.connect(new StdioServerTransport());
