import { useId } from "react";
import logo from "./assets/growth-factory-logo.png";
import "./brand-mark.css";

/** Frame the supplied artwork rather than its transparent export padding.
 *  The artwork is tinted with the current text colour, so CSS sets the
 *  brand colour with `color` instead of a filter chain. */
export function BrandMark() {
  const tint = `gf-brand-tint-${useId().replace(/:/g, "")}`;
  return (
    <svg
      className="gf-brand-logo"
      viewBox="140 112 337 186"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <filter id={tint} colorInterpolationFilters="sRGB">
          <feFlood floodColor="currentColor" />
          <feComposite in2="SourceAlpha" operator="in" />
        </filter>
      </defs>
      <image href={logo} width="612" height="408" filter={`url(#${tint})`} />
    </svg>
  );
}
