import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import type { UpstreamService } from "./upstream-service.js";

export interface GatewayServerOptions {
  onSuccessfulToolCall?: () => Promise<void> | void;
}

export function createGatewayServer(
  upstreams: UpstreamService,
  filterAlias?: string,
  options: GatewayServerOptions = {},
): Server {
  const server = new Server(
    { name: filterAlias ? `mcp-nexus-${filterAlias}` : "mcp-nexus-gateway", version: "0.2.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const routed = await upstreams.listTools(filterAlias);
    return {
      tools: routed.map(({ publicName, upstreamAlias, tool }) => ({
        ...tool,
        name: publicName,
        description: `[${upstreamAlias}] ${tool.description ?? tool.name}`,
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const result = await upstreams.callTool(request.params.name, request.params.arguments, filterAlias);
      if (result.isError !== true && options.onSuccessfulToolCall) {
        await Promise.allSettled([options.onSuccessfulToolCall()]);
      }
      return result;
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: publicError(error) }],
      };
    }
  });

  return server;
}

function publicError(error: unknown): string {
  if (!(error instanceof Error)) return "Upstream MCP request failed";
  return error.message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 500);
}
