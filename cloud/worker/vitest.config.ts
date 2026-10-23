import { defineConfig } from 'vitest/config';

/**
 * Worker tests use the existing vitest setup (same runner, same generous
 * timeouts); they live in their own config for two reasons:
 *
 * 1. The root vitest config includes only the repo-root test folder, and the house
 *    rule for this branch is to not modify anything outside cloud/worker.
 * 2. The worker is plain Request/Response/fetch code, so it runs under the Node
 *    environment with no wrangler, no miniflare, and no Cloudflare package.
 *
 * Run with: npx vitest run -c cloud/worker/vitest.config.ts
 */
export default defineConfig({
  root: import.meta.dirname,
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Matches the root config: a slow Overpass-shaped retry loop in the library
    // must not read as a broken test.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
