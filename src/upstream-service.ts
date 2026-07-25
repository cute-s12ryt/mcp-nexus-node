import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";

import type { UpstreamConfig } from "./app-state.js";
import { assertSafeRemoteUrl } from "./network-policy.js";
import type { StateStore } from "./state-store.js";
import { applyUpstreamAuthentication, redactUpstreamAuthentication } from "./upstream-auth.js";

export interface RoutedTool {
  publicName: string;
  upstreamAlias: string;
  originalName: string;
  tool: Tool;
}

export class UpstreamService {
  #operationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly store: StateStore, private readonly maxTools = 256) {}

  async listTools(filterAlias?: string): Promise<RoutedTool[]> {
    const configs = await this.getEnabledConfigs(filterAlias);
    const routed: RoutedTool[] = [];
    let failures = 0;
    for (const config of configs) {
      try {
        const tools = await this.listOne(config, filterAlias !== undefined, this.maxTools - routed.length);
        routed.push(...tools);
      } catch {
        failures += 1;
      }
      if (routed.length >= this.maxTools) break;
    }
    if (configs.length > 0 && failures === configs.length) throw new Error("All configured upstream MCP servers failed");
    return routed;
  }

  async test(alias: string): Promise<{ toolCount: number; serverName?: string }> {
    const config = await this.getConfig(alias);
    return this.withClient(config, async (client) => {
      const tools = await this.collectTools(client, config.alias, this.maxTools);
      return { toolCount: tools.length, serverName: client.getServerVersion()?.name };
    });
  }

  async callTool(publicName: string, args: Record<string, unknown> | undefined, filterAlias?: string): Promise<CallToolResult> {
    const route = filterAlias
      ? { alias: filterAlias, originalName: publicName }
      : splitPublicName(publicName);
    const config = await this.getConfig(route.alias);
    if (!config.enabled) throw new Error(`Upstream ${route.alias} is disabled`);
    return this.withClient(config, async (client) => {
      const result = await client.callTool(
        { name: route.originalName, arguments: args },
        CallToolResultSchema,
        { timeout: 45_000 },
      );
      return CallToolResultSchema.parse(result);
    });
  }

  private async listOne(config: UpstreamConfig, preserveNames: boolean, remainingLimit: number): Promise<RoutedTool[]> {
    if (remainingLimit <= 0) return [];
    return this.withClient(config, async (client) => {
      const tools = await this.collectTools(client, config.alias, remainingLimit);
      return tools.map((tool) => ({
        publicName: preserveNames ? tool.name : `${config.alias}.${tool.name}`,
        upstreamAlias: config.alias,
        originalName: tool.name,
        tool,
      }));
    });
  }

  private async withClient<T>(config: UpstreamConfig, operation: (client: Client) => Promise<T>): Promise<T> {
    const queued = this.#operationQueue.catch(() => undefined).then(() => this.runWithClient(config, operation));
    this.#operationQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  private async runWithClient<T>(config: UpstreamConfig, operation: (client: Client) => Promise<T>): Promise<T> {
    const safeEndpoint = await assertSafeRemoteUrl(config.endpoint);
    const { endpoint, headers } = applyUpstreamAuthentication(config, safeEndpoint);
    const client = new Client({ name: "mcp-nexus-gateway", version: "0.2.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(endpoint, { requestInit: { headers, redirect: "error" } });
    let result: T | undefined;
    let operationError: unknown;
    let operationFailed = false;
    try {
      await client.connect(transport, { timeout: 15_000 });
      result = await operation(client);
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }
    let closeError: unknown;
    try {
      await client.close();
    } catch (error) {
      closeError = error;
    }
    if (operationFailed) throw redactUpstreamAuthentication(operationError, config);
    if (closeError !== undefined) throw redactUpstreamAuthentication(closeError, config);
    return result as T;
  }

  private async collectTools(client: Client, alias: string, limit: number): Promise<Tool[]> {
    const tools: Tool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const response = await client.listTools(cursor ? { cursor } : undefined, { timeout: 15_000 });
      if (tools.length + response.tools.length > limit) {
        throw new Error(`Upstream tool catalog exceeded the ${this.maxTools}-tool limit`);
      }
      tools.push(...response.tools);
      cursor = response.nextCursor;
      if (!cursor) return tools;
    }
    throw new Error(`Upstream ${alias} exceeded the 20-page tool limit`);
  }

  private async getEnabledConfigs(filterAlias?: string): Promise<UpstreamConfig[]> {
    const { upstreams } = await this.store.read();
    const configs = upstreams.filter((config) => config.enabled && (!filterAlias || config.alias === filterAlias));
    if (filterAlias && configs.length === 0) throw new Error(`Unknown or disabled upstream: ${filterAlias}`);
    return configs;
  }

  private async getConfig(alias: string): Promise<UpstreamConfig> {
    const { upstreams } = await this.store.read();
    const config = upstreams.find((candidate) => candidate.alias === alias);
    if (!config) throw new Error(`Unknown upstream: ${alias}`);
    return config;
  }
}

function splitPublicName(publicName: string): { alias: string; originalName: string } {
  const separator = publicName.indexOf(".");
  if (separator <= 0 || separator === publicName.length - 1) throw new Error(`Unknown aggregated tool: ${publicName}`);
  return { alias: publicName.slice(0, separator), originalName: publicName.slice(separator + 1) };
}
