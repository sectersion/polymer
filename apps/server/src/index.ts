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

  void import("./server.js").then(async ({ createPolymerServer }) => {
    const { server } = await createPolymerServer();
    server.listen(port, host, () => {
      console.log(`polymer server ready on ${host}:${port}`);
    });

    const shutdown = (signal: string) => {
      console.log(`polymer server received ${signal}, shutting down cleanly`);
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1000).unref();
    };

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  });
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("dist/index.js") ||
    process.argv[1].endsWith("src/index.ts"));

if (invokedDirectly) {
  main();
}
