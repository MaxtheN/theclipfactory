/**
 * For polled state: keep the current value when the service sent back the same data, so an
 * unchanged poll does not re-render the screen or invalidate memoized work built on it.
 * Use as `setRows(old => keepIfSame(old, next))`.
 */
export function keepIfSame<T>(old: T, next: T): T {
  if (old === next) return old;
  try {
    return JSON.stringify(old) === JSON.stringify(next) ? old : next;
  } catch {
    return next;
  }
}
