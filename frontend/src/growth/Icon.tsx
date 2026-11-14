import type { CSSProperties } from "react";
const paths: Record<string, string> = {
  setup: "M4 5h16v14H4z M8 3v4 M16 3v4 M8 11h8 M8 15h5",
  research: "M16 16l5 5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  studio:
    "M3 8h18v12H3z M3 8V4h18v4 M8 4l-3 4 M14 4l-3 4 M20 4l-3 4 M10 12l5 3-5 3z",
  results: "M4 20V12 M10 20V4 M16 20V8 M22 20V2",
  arrow: "M4 12h16 M14 6l6 6-6 6",
  send: "M22 2L9 15 M22 2l-8 20-5-7-7-5 20-8z",
  back: "M20 12H4 M10 6l-6 6 6 6",
  check: "M5 12l4 4L19 6",
  plus: "M12 5v14 M5 12h14",
  down: "M6 9l6 6 6-6",
  upload:
    "M7 17H5a4 4 0 0 1-1-8 7 7 0 0 1 13-2 5 5 0 0 1 2 10h-2 M12 20V9 M8 13l4-4 4 4",
  folder: "M3 6h7l2 3h9v11H3z M3 6V4h6l2 2",
  play: "M9 5l11 7-11 7z",
  spark: "M12 2l3 7 7 3-7 3-3 7-3-7-7-3 7-3z",
  lock: "M5 10h14v11H5z M8 10V6a4 4 0 0 1 8 0v4 M12 14v3",
  settings: "M4 7h16 M4 17h16 M8 4v6 M16 14v6",
  close: "M6 6l12 12 M18 6L6 18",
  info: "M12 11v6 M12 7h.01 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
  clock: "M12 6v6l4 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
  file: "M5 2h9l5 5v15H5z M14 2v6h5 M9 13h6 M9 17h6",
  download: "M12 3v12 M7 10l5 5 5-5 M4 16v5h16v-5",
  refresh: "M20 7v5h-5 M4 17v-5h5 M19 12a7 7 0 0 0-12-5 M5 12a7 7 0 0 0 12 5",
  link: "M9 15l6-6 M8 17l-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0 M16 7l1-1a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0",
  headphones: "M4 13V10a8 8 0 0 1 16 0v3 M4 11h3v9H3v-7z M20 11h-3v9h4v-7z",
};
export function Icon({
  name,
  size = 18,
  style,
}: {
  name: string;
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={style}
    >
      <path d={paths[name] || paths.info} />
    </svg>
  );
}
