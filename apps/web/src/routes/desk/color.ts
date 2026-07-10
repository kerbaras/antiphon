/** Hex color at an alpha, via color-mix (works with CSS variables too). */
export function hexA(hex: string, alpha: number): string {
  return `color-mix(in srgb, ${hex} ${Math.round(alpha * 100)}%, transparent)`;
}
