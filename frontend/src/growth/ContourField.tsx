import { useEffect, useRef } from "react";
import { startContours, type ContourHandle } from "./contours";
import "./contour-field.css";

/** The first ripple waits for the welcome to rise into place. */
const FIRST_RIPPLE_DELAY_MS = 300;

/**
 * The moving map behind onboarding. On mount and whenever `pulseKey` changes, a ripple rolls out
 * from the element marked `data-ripple-origin` in the same section (the brand mark, the current
 * step), or from the centre when that element isn't showing. Render it only when
 * contoursSupported() says the field can run; otherwise the section keeps its plain background.
 */
export function ContourField({ pulseKey }: { pulseKey: string | number }) {
  const host = useRef<HTMLDivElement>(null);
  const field = useRef<ContourHandle | null>(null);
  const first = useRef(true);
  useEffect(() => {
    const handle = host.current ? startContours(host.current) : null;
    field.current = handle;
    return () => {
      handle?.stop();
      field.current = null;
    };
  }, []);
  useEffect(() => {
    const origin = host.current?.parentElement?.querySelector("[data-ripple-origin]");
    const box = origin?.getBoundingClientRect();
    field.current?.pulse(
      box && box.width > 0
        ? { x: box.left + box.width / 2, y: box.top + box.height / 2 }
        : undefined,
      first.current ? FIRST_RIPPLE_DELAY_MS : 0,
    );
    first.current = false;
  }, [pulseKey]);
  return <div ref={host} className="gf-contours" aria-hidden="true" />;
}
