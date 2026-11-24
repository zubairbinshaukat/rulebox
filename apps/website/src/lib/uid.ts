/** Ids that are unique across one build (inline SVG clip paths and gradients). */
let next = 0;
export function uid(prefix: string): string {
  next += 1;
  return `${prefix}-${next}`;
}
