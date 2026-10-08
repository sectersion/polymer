import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VERSION } from "../index.js";
import type { PolymerDatabase } from "../database/db.js";
import { registerAgentTools } from "./agent-tools.js";
import { registerProbeTool } from "./probe.js";
import { registerTaskTools } from "./task-tools.js";

export const MCP_PATH = "/mcp";

export interface McpServerOptions {
  /**
   * Component 14: register test-only probe tools (`__test_lease_write`)
   * alongside the real surface. Default false — probes never ship in
   * production builds; the full POLYMER.json config loader arrives with
   * its component, this option is its gate seam until then.
   */
  testSeams: boolean;
}

const DEFAULT_MCP_SERVER_OPTIONS: McpServerOptions = { testSeams: false };

/**
 * The MCP surface: agent lifecycle tools, task tools sharing the
 * component-14 fencing guard, and (testSeams builds only) the
 * component-14 lease probe. Tool implementations live in ./mcp/*.
 */
export function createMcpServer(
  db: PolymerDatabase | null = null,
  options: McpServerOptions = DEFAULT_MCP_SERVER_OPTIONS,
): McpServer {
  const server = new McpServer({ name: "polymer", version: VERSION });
  registerAgentTools(server, db);
  registerTaskTools(server, db);
  if (options.testSeams) {
    registerProbeTool(server, db);
  }
  return server;
}
