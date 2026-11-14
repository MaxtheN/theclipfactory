import logo from "./assets/growth-factory-logo.png";
import "./brand-mark.css";

/** Frame the supplied artwork rather than its transparent export padding. */
export function BrandMark() {
  return (
    <svg
      className="gf-brand-logo"
      viewBox="140 112 337 186"
      aria-hidden="true"
      focusable="false"
    >
      <image href={logo} width="612" height="408" />
    </svg>
  );
}
