import { defineConfig } from "vitest/config";

// templates/ holds example Playwright tests for users' repos, and test/docker needs Docker: `npm run test:docker`.
export default defineConfig({ test: { include: ["test/*.test.ts"] } });
