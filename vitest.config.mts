import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Same .env loading as prisma.config.ts; an already-set variable wins over the file.
try {
  process.loadEnvFile();
} catch {
  // no .env file: rely on the real environment
}

const testDb = process.env.TEST_DATABASE_URL;
if (!testDb || testDb === process.env.DATABASE_URL) {
  throw new Error("Set TEST_DATABASE_URL to a separate database: the suite truncates its tables.");
}
// Runs before global setup applies migrations, so a mis-pointed URL is refused before it is
// touched. The database name has to end in _test (the same rule tests/helpers.ts applies before
// truncating); this also catches the app database reached through another hostname or parameter.
// Limit: this reads the URL; it does not ask the server which database it is.
const testDbName = decodeURIComponent(new URL(testDb).pathname.replace(/^\//, ""));
if (!testDbName.endsWith("_test")) {
  throw new Error(`TEST_DATABASE_URL must point at a database whose name ends in _test (got "${testDbName}").`);
}

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    // lib/db.ts reads DATABASE_URL at import; test.env reaches the workers (vitest.dev/config/env).
    env: { DATABASE_URL: testDb },
    // Test files share one database and truncate it.
    fileParallelism: false,
    // next-auth imports "next/server" without an extension, which Node's ESM loader rejects
    // (next has no exports map); letting Vite resolve it fixes that.
    server: { deps: { inline: ["next-auth"] } },
  },
});
