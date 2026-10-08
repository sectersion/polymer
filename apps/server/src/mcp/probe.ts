import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { PolymerDatabase } from "../database/db.js";
import { testLeaseWrite } from "../tasks/index.js";
import { callerAgentId, taskToolError, toolResult } from "./shared.js";

export function registerProbeTool(
  server: McpServer,
  db: PolymerDatabase | null,
): void {
  // Component 14 probe: proves the shared fencing guard in isolation
  // via a no-op write. Registered only under the caller's testSeams
  // gate; never present in production builds.
  server.registerTool(
    "__test_lease_write",
    {
      description:
        "Test-only: run a no-op write through the coordinator lease guard (testSeams builds only)",
      inputSchema: {
        task_id: z.string().min(1),
        lease_generation: z.number().int(),
        expected_version: z.number().int(),
      },
    },
    async (args, extra) => {
      if (db === null) {
        throw new McpError(ErrorCode.InternalError, "database_error");
      }
      const caller = callerAgentId(extra);
      if (caller === undefined) {
        throw new McpError(ErrorCode.InvalidRequest, "unauthorized");
      }
      try {
        const out = testLeaseWrite(
          db,
          args.task_id,
          caller,
          args.lease_generation,
          args.expected_version,
        );
        return toolResult({ ...out });
      } catch (err) {
        taskToolError(err);
      }
    },
  );
}
