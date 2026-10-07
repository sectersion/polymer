export const VERSION = "0.0.0";

export const DEFAULT_PORT = 8080;
export const DEFAULT_HOST = "127.0.0.1";

export function buildStartupMessage(
  host: string = DEFAULT_HOST,
  port: number = DEFAULT_PORT,
): string {
  return `polymer server v${VERSION} starting on ${host}:${port}`;
}

function parsePort(argv: string[]): number {
  const idx = argv.indexOf("--port");
  if (idx !== -1) {
    const raw = argv[idx + 1];
    const parsed = Number.parseInt(raw ?? "", 10);
    if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) {
      return parsed;
    }
    throw new Error(`invalid --port value: ${raw}`);
  }
  const envPort = Number.parseInt(process.env.POLYMER_PORT ?? "", 10);
  if (Number.isInteger(envPort) && envPort > 0 && envPort < 65536) {
    return envPort;
  }
  return DEFAULT_PORT;
}

function main(): void {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("Usage: polymer-server [--port <port>]");
    return;
  }

  const port = parsePort(process.argv.slice(2));
  const host = process.env.POLYMER_HOST ?? DEFAULT_HOST;

  console.log(buildStartupMessage(host, port));
  console.log(
    "polymer server ready (skeleton: no SQLite, MCP, REST, or telemetry yet)",
  );

  const shutdown = (signal: string) => {
    console.log(`polymer server received ${signal}, shutting down cleanly`);
    process.exit(0);
  };

  // Skeleton keep-alive: nothing listens yet (HTTP arrives in component 1),
  // and an awaited promise alone does not hold the event loop. A ref'd
  // timer does; the HTTP listener replaces it in component 1.
  const keepAlive = setInterval(() => {}, 60_000);
  process.on("SIGINT", () => {
    clearInterval(keepAlive);
    shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    clearInterval(keepAlive);
    shutdown("SIGTERM");
  });
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("dist/index.js") ||
    process.argv[1].endsWith("src/index.ts"));

if (invokedDirectly) {
  main();
}
