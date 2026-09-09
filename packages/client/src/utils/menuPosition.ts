/**
 * Where to open a context menu for an event.
 *
 * A keyboard-invoked contextmenu (the Menu key, or Shift+F10) reports 0,0 for
 * its coordinates, which would pin the menu to the top-left corner. Fall back
 * to the bottom-left of the element the event came from, so the menu appears
 * next to whatever the user has focused.
 */
export function menuPosition(e: MouseEvent): { x: number; y: number } {
  if (e.clientX !== 0 || e.clientY !== 0) return { x: e.clientX, y: e.clientY };
  const target = e.currentTarget as HTMLElement | null;
  if (!target?.getBoundingClientRect) return { x: 0, y: 0 };
  const rect = target.getBoundingClientRect();
  return { x: Math.round(rect.left), y: Math.round(rect.bottom) };
}
