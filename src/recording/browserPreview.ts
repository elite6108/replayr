/** Physical pixels of a browser page over its preview box. `host` is the canvas in CSS pixels. */

export type BrowserPreviewBounds = { x: number; y: number; width: number; height: number };

export function browserPreviewBounds(
  host: { left: number; top: number; width: number; height: number },
  transform: { x: number; y: number; w: number; h: number },
  dpr: number,
  insetCss: number,
): BrowserPreviewBounds | null {
  const scale = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const inset = Math.max(0, insetCss) * scale;
  const x = (host.left + transform.x * host.width) * scale + inset;
  const y = (host.top + transform.y * host.height) * scale + inset;
  const width = transform.w * host.width * scale - inset * 2;
  const height = transform.h * host.height * scale - inset * 2;
  if (![x, y, width, height].every((value) => Number.isFinite(value)) || width < 8 || height < 8) return null;
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}
