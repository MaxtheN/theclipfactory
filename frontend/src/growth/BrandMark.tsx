import "./brand-mark.css";

/** The Growth Factory mark: a play triangle cut into three clips, on a Signal orange tile. */
export function BrandMark() {
  return (
    <svg className="gf-brand-logo" viewBox="0 0 120 120" aria-hidden="true" focusable="false">
      <rect width="120" height="120" rx="30" fill="#FF5A1F" />
      <g
        transform="translate(43 30) scale(0.6)"
        fill="#FFFFFF"
        stroke="#FFFFFF"
        strokeWidth="4"
        strokeLinejoin="round"
      >
        <path d="M0 0L22 12.79V87.21L0 100Z" />
        <path d="M34 19.77L56 32.56V67.44L34 80.23Z" />
        <path d="M68 39.53L86 50L68 60.47Z" />
      </g>
    </svg>
  );
}
