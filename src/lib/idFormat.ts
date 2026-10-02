/**
 * Numeric-ID migration: the one deterministic way to turn a numeric id into a short display / reference
 * fragment (replaces the pre-migration `cuid.slice(-6)` suffixes). Zero-padded to `width` digits; ids with
 * more digits are printed in full (never truncated — truncation could collide).
 * Only NEWLY generated references use it; stored business references are never rewritten.
 */
export function idRef(id: number, width = 6): string {
	return String(id).padStart(width, '0');
}
