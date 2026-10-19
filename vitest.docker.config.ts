import { defineConfig } from "vitest/config";

// Real sandboxes on the local Docker daemon. Needs a build first: `npm run test:docker` does both.
export default defineConfig({ test: { include: ["test/docker/*.test.ts"], testTimeout: 900_000, hookTimeout: 300_000 } });
