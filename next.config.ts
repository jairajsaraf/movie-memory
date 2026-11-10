import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep the dev server from writing an AGENTS.md into the repo.
  agentRules: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
