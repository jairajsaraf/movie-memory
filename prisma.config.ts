import { defineConfig, env } from "prisma/config";

// Prisma 7 does not load .env itself; Node 24 can (no dotenv dependency).
try {
  process.loadEnvFile();
} catch {
  // no .env file: rely on the real environment
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: env("DATABASE_URL") },
});
