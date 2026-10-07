#!/usr/bin/env node
/**
 * Component 4 CLI: pnpm migrate:up | migrate:down | migrate:reset
 * Usage: migrate.ts [up|down|reset] [--db <path>]
 * Path resolution: --db flag > POLYMER_DATABASE_PATH env > ./polymer.db
 */
import {
  closeDatabase,
  getSchemaVersion,
  migrateDown,
  migrateReset,
  migrateUp,
  openDatabase,
  resolveDatabasePath,
} from "./db.js";

function parseArgs(argv: string[]): { command: string; dbPath: string } {
  const [command = "up"] = argv;
  const flagIdx = argv.indexOf("--db");
  const dbPath =
    flagIdx !== -1 && argv[flagIdx + 1]
      ? argv[flagIdx + 1]!
      : resolveDatabasePath();
  return { command, dbPath };
}

function main(): void {
  const { command, dbPath } = parseArgs(process.argv.slice(2));
  if (command === "reset") {
    const db = migrateReset(dbPath);
    try {
      console.log(`reset ${dbPath} to schema version ${getSchemaVersion(db)}`);
    } finally {
      closeDatabase(db);
    }
    return;
  }
  const db = openDatabase(dbPath);
  try {
    if (command === "up") {
      const applied = migrateUp(db);
      console.log(
        applied.length === 0
          ? `${dbPath} already at schema version ${getSchemaVersion(db)}`
          : `migrated ${dbPath}: applied [${applied.join(", ")}], now at version ${getSchemaVersion(db)}`,
      );
    } else if (command === "down") {
      const rolledBack = migrateDown(db);
      console.log(
        rolledBack === null
          ? `${dbPath} has no applied migrations`
          : `rolled back version ${rolledBack} on ${dbPath}, now at version ${getSchemaVersion(db)}`,
      );
    } else {
      console.error(`unknown command: ${command} (expected up|down|reset)`);
      process.exitCode = 1;
    }
  } finally {
    closeDatabase(db);
  }
}

main();
