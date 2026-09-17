const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

function midChar(a: number, b: number): string {
  return ALPHABET[Math.floor((a + b) / 2)] ?? "n";
}

function indexOf(ch: string): number {
  const idx = ALPHABET.indexOf(ch);
  return idx < 0 ? 0 : idx;
}

/** Rank strictly between `before` and `after`. Empty means -inf / +inf. */
export function rankBetween(before?: string | null, after?: string | null): string {
  const left = (before || "").replace(/[^0-9a-z]/g, "");
  const right = (after || "").replace(/[^0-9a-z]/g, "");
  if (!left && !right) return "n";
  if (!left) {
    if (right <= "1") return `0${right}`;
    return ALPHABET[Math.max(0, indexOf(right[0]!) - 1)] + right.slice(1);
  }
  if (!right) {
    return `${left}n`;
  }
  const max = Math.max(left.length, right.length);
  let prefix = "";
  for (let i = 0; i < max + 1; i++) {
    const lo = i < left.length ? indexOf(left[i]!) : -1;
    const hi = i < right.length ? indexOf(right[i]!) : ALPHABET.length;
    if (hi - lo > 1) {
      return prefix + midChar(lo, hi);
    }
    prefix += left[i] ?? "0";
  }
  return `${left}n`;
}

export function rankAfter(last?: string | null): string {
  return rankBetween(last || null, null);
}
