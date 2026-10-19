/**
 * Shared summary-helper logic, in the example folder on purpose: the example
 * scripts and their tests import one implementation instead of each padding
 * the rules.
 */

/**
 * Warnings for one budget: the capture warnings rebuilt fresh, plus one
 * omissions line only when THIS budget dropped something, never carried over
 * from another budget. Unit on the line: features omitted.
 */
export function budgetWarnings(
  captureWarnings: readonly string[],
  omissions: ReadonlyArray<{ layer: string; count: number }>,
): string[] {
  const warnings = [...captureWarnings];
  if (omissions.length > 0) {
    warnings.push(
      `budget omissions: ${omissions.map((o) => `${o.count} ${o.layer}(s)`).join(', ')} (unit: features omitted)`,
    );
  }
  return warnings;
}
