import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    /**
     * Generous, because several tests compile a dense synthetic grid at three
     * budgets and that takes seconds on a loaded machine.
     *
     * The default of 5s was producing intermittent failures that looked like
     * logic bugs and were not: `compile.named-places.test.ts` failed on
     * unmodified HEAD, and `bench.validity.test.ts` failed only when run alongside
     * it, both with "Test timed out in 5000ms" rather than a failed assertion. A
     * timeout reported as a test failure trains the reader to distrust the suite,
     * which is worse than a slow suite.
     *
     * Raising the ceiling does not slow anything down. A test that genuinely hangs
     * still fails, just later.
     *
     * Raised again from 30s to 60s after `bench.frozen-truth.test.ts` failed once
     * in four full-suite runs and never again. It compiles a 4,570-feature grid,
     * and it shares a phone with every other suite in the run, so its per-test cost
     * is a function of machine speed as much as of code. A flaky suite trains the
     * reader to distrust the results, which is the specific failure this file exists
     * to prevent.
     */
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
