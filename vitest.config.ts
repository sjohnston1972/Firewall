import { defineConfig } from "vitest/config";

// Plain Node test environment is sufficient for the deterministic core
// (IR schema, plan engine, packs). These modules use only standard globals.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
