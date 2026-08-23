const liked = new Set<string>();
const listeners = new Set<() => void>();

export function isClipLiked(slug: string) {
  return liked.has(slug);
}

export function toggleClipLike(slug: string) {
  if (liked.has(slug)) liked.delete(slug);
  else liked.add(slug);
  for (const notify of listeners) notify();
  return liked.has(slug);
}

export function subscribeLikes(notify: () => void) {
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
  };
}
