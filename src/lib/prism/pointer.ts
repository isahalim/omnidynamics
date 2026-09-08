/**
 * The pointer the scene leans toward, from a mouse or from a finger.
 *
 * A mouse is read absolutely: there is a cursor on the wall whether or not a
 * button is down, so the camera simply follows it, and when it leaves the
 * window the scene settles back to centre.
 *
 * A finger has no hover. Read absolutely, the first touch would slam the view
 * to whichever edge was tapped, so a touch is read as a drag instead: the
 * position moves by how far the finger has travelled since it went down,
 * starting from wherever the scene was already looking, and it stays there when
 * the finger lifts. That is what makes the prism and the pyramid something you
 * turn on a phone rather than something that twitches at a tap.
 */
import type { Vec2 } from "./constants";

/**
 * How much of the range a drag across the whole screen covers. Above 1 a finger
 * can reach the ends of the swing without crossing the entire display, which
 * matters most on a phone held in one hand.
 */
const TOUCH_DRAG_GAIN = 1.8;

export interface PointerFollow {
  /** Where to lean, as -1 to 1 across the viewport. */
  onMove(position: Vec2): void;
  /** The mouse left the window. Touch never leaves; it lifts where it is. */
  onLeave(): void;
  /** Where the scene is aimed now, so a drag can start from there. */
  read(): Vec2;
}

const clampUnit = (value: number) => Math.min(1, Math.max(-1, value));

const positionOf = (event: PointerEvent): Vec2 => [
  (event.clientX / Math.max(window.innerWidth, 1)) * 2 - 1,
  (event.clientY / Math.max(window.innerHeight, 1)) * 2 - 1,
];

/** Attaches the listeners and returns the function that removes them again. */
export function followPointer(follow: PointerFollow): () => void {
  let dragPointer: number | undefined;
  let dragOrigin: Vec2 = [0, 0];
  let dragFrom: Vec2 = [0, 0];

  const isMouse = (event: PointerEvent) =>
    !event.pointerType || event.pointerType === "mouse";

  const onPointerDown = (event: PointerEvent) => {
    if (isMouse(event)) return;
    dragPointer = event.pointerId;
    dragOrigin = positionOf(event);
    dragFrom = follow.read();
  };

  const onPointerMove = (event: PointerEvent) => {
    if (isMouse(event)) {
      const [x, y] = positionOf(event);
      follow.onMove([clampUnit(x), clampUnit(y)]);
      return;
    }
    if (event.pointerId !== dragPointer) return;
    const [x, y] = positionOf(event);
    follow.onMove([
      clampUnit(dragFrom[0] + (x - dragOrigin[0]) * TOUCH_DRAG_GAIN),
      clampUnit(dragFrom[1] + (y - dragOrigin[1]) * TOUCH_DRAG_GAIN),
    ]);
  };

  const onPointerUp = (event: PointerEvent) => {
    if (event.pointerId === dragPointer) dragPointer = undefined;
  };

  // Only a mouse can leave: `relatedTarget` is null when it crosses the window
  // edge rather than moving between elements.
  const onPointerOut = (event: PointerEvent) => {
    if (isMouse(event) && event.relatedTarget === null) follow.onLeave();
  };

  const onBlur = () => {
    dragPointer = undefined;
    follow.onLeave();
  };

  window.addEventListener("pointerdown", onPointerDown, { passive: true });
  window.addEventListener("pointermove", onPointerMove, { passive: true });
  window.addEventListener("pointerup", onPointerUp, { passive: true });
  window.addEventListener("pointercancel", onPointerUp, { passive: true });
  window.addEventListener("pointerout", onPointerOut);
  window.addEventListener("blur", onBlur);

  return () => {
    window.removeEventListener("pointerdown", onPointerDown);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
    window.removeEventListener("pointerout", onPointerOut);
    window.removeEventListener("blur", onBlur);
  };
}
