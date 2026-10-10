import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VERSION } from "../index.js";
import type { PolymerDatabase } from "../database/db.js";
import type { EventBus } from "../http/events.js";
import { registerAgentTools } from "./agent-tools.js";
import { registerCommentTools } from "./comment-tools.js";
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
  /**
   * Component 21: the fleet event bus. Mutation tools publish
   * task/agent/comment changes to live admin sockets through it.
   * Required in production; test servers that don't care about
   * events pass a throwaway bus.
   */
  events: EventBus;
}

/**
 * The MCP surface: agent lifecycle tools, task tools sharing the
 * component-14 fencing guard, and (testSeams builds only) the
 * component-14 lease probe. Tool implementations live in ./mcp/*.
 */
export function createMcpServer(
  db: PolymerDatabase | null = null,
  options: McpServerOptions,
): McpServer {
  const server = new McpServer({ name: "polymer", version: VERSION });
  registerAgentTools(server, db, options.events);
  registerTaskTools(server, db, options.events);
  registerCommentTools(server, db, options.events);
  if (options.testSeams) {
    registerProbeTool(server, db);
  }
  return server;
}
