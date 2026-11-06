export type DisplayInfo = {
  id: string;
  name: string;
  width: number;
  height: number;
  refreshRate: number;
  isPrimary: boolean;
  x: number;
  y: number;
};

export function displaySize(display: DisplayInfo): string {
  return display.width && display.height ? `${display.width}×${display.height}` : "Unknown";
}

export function displayMeta(display: DisplayInfo): string {
  const size = displaySize(display);
  return display.refreshRate ? `${size} · ${display.refreshRate} Hz` : size;
}

/** `\\.\DISPLAY2` → 2. Matches the number Windows shows in Display settings → Identify. */
export function displayNumber(display: Pick<DisplayInfo, "id">): number | null {
  const match = /DISPLAY(\d+)$/i.exec(display.id);
  return match ? Number(match[1]) : null;
}

export function displayTitle(display: DisplayInfo): string {
  const number = displayNumber(display);
  const generic = !display.name || /generic|pnp|^display\d*$/i.test(display.name.replace(/\s+/g, ""));
  if (number == null) return display.name || "Display";
  return generic ? `Display ${number}` : `Display ${number} · ${display.name}`;
}

/** Where a display sits relative to the primary one, for picking between identical monitors. */
export function displayPosition(display: DisplayInfo, displays: DisplayInfo[]): string | null {
  if (display.isPrimary || displays.length < 2) return null;
  const primary = displays.find((item) => item.isPrimary);
  if (!primary) return null;
  const dx = display.x - primary.x;
  const dy = display.y - primary.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? "Left of primary" : "Right of primary";
  return dy < 0 ? "Above primary" : "Below primary";
}

export function displayLabel(display: DisplayInfo): string {
  const primary = display.isPrimary ? " — Primary" : "";
  return `${display.name} — ${displaySize(display)}${primary}`;
}
