/** The smallest room, in the interface's own pixels, the desktop layout still works in. */
export const SCALE_FIT = { width: 1024, height: 600 }

/**
 * The interface size a window can actually take. The page is zoomed rather than reflowed,
 * so the layout switches between desktop and phone on the real window width: zoomed past
 * what the window holds, the desktop layout stays up and its edges fall off the screen.
 * A larger choice is held back to what fits; a smaller one, or 100%, is always allowed,
 * since below that the phone layout takes over.
 */
export function fittedScale(chosen: number, width: number, height: number): number {
  if (!width || !height) return chosen
  const fit = Math.floor(100 * Math.min(width / SCALE_FIT.width, height / SCALE_FIT.height))
  return Math.max(Math.min(chosen, fit), Math.min(chosen, 100))
}
