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

export function displayLabel(display: DisplayInfo): string {
  const primary = display.isPrimary ? " — Primary" : "";
  return `${display.name} — ${displaySize(display)}${primary}`;
}
