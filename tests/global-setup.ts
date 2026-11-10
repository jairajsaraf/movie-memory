import { execSync } from "node:child_process";

// Apply migrations to the test database once per run. vitest.config.mts has already refused to
// start unless TEST_DATABASE_URL is set and differs from DATABASE_URL.
export default function setup() {
  execSync("npx prisma migrate deploy", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL },
  });
}
