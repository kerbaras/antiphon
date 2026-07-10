// Pointer/keyboard interaction helpers shared by draggable controls.

/** Route pointermove to `move` until pointerup; both listeners self-clean. */
export function trackPointerDrag(
  move: (e: PointerEvent) => void,
  onUp?: (e: PointerEvent) => void,
): void {
  const up = (e: PointerEvent) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    onUp?.(e);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

/** Slider keyboard convention: arrows step, Home/End hit the rails.
 * Returns the next value, or null for unrelated keys. */
export function sliderStep(
  key: string,
  values: { up: number; down: number; home: number; end: number },
): number | null {
  if (key === "ArrowUp" || key === "ArrowRight") return values.up;
  if (key === "ArrowDown" || key === "ArrowLeft") return values.down;
  if (key === "Home") return values.home;
  if (key === "End") return values.end;
  return null;
}
