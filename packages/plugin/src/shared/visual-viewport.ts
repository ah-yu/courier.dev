/** The part of a rectangle the calculations below need. */
export interface RectLike {
  top: number;
  bottom: number;
}

/**
 * How much of the layout viewport the on-screen keyboard covers.
 *
 * A mobile WebView keeps `window.innerHeight` at the layout viewport while the keyboard
 * overlays the page; the visual viewport shrinks to the part still visible. The gap between
 * the two is what a bottom-anchored sheet has to move up by. `offsetTop` is the visual
 * viewport's scroll offset, which some keyboards introduce when they scroll the focused
 * field into view: the keyboard starts below the visual viewport's *bottom*, not below its
 * height.
 *
 * Negative and non-finite results are clamped to zero: a layout viewport that is already
 * shorter than the visual one means the platform resized the page instead of overlaying it,
 * and there is nothing left for this device to compensate.
 */
export function keyboardInset(
  innerHeight: number,
  visualHeight: number,
  visualOffsetTop = 0,
): number {
  if (!Number.isFinite(innerHeight) || !Number.isFinite(visualHeight)) return 0;
  const offset = Number.isFinite(visualOffsetTop) ? visualOffsetTop : 0;
  return Math.max(0, Math.round(innerHeight - offset - visualHeight));
}

/**
 * The scroll delta that brings `field` inside `body`'s visible band.
 *
 * Positive means "scroll down" (the field is below the body's bottom edge); negative means
 * "scroll up". A field that is already inside the band, with `margin` to spare, asks for no
 * movement — otherwise a keyboard resize would nudge the form on every frame.
 */
export function revealScrollDelta(body: RectLike, field: RectLike, margin = 12): number {
  const bottomOverflow = field.bottom - (body.bottom - margin);
  if (bottomOverflow > 0) return Math.ceil(bottomOverflow);

  const topOverflow = body.top + margin - field.top;
  if (topOverflow > 0) return -Math.ceil(topOverflow);

  return 0;
}
