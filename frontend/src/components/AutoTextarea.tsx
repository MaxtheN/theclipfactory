import {
  forwardRef,
  useCallback,
  useLayoutEffect,
  useRef,
  type TextareaHTMLAttributes,
} from "react";

type AutoTextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  /** Maximum outer height before the field scrolls internally. */
  maxAutoHeight?: number;
};

const measurementProperties = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "fontVariant",
  "letterSpacing",
  "lineHeight",
  "textTransform",
  "textIndent",
  "wordSpacing",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "borderStyle",
  "tabSize",
  "wordBreak",
  "overflowWrap",
] as const;

const pixels = (value: string) => Number.parseFloat(value) || 0;

/** Measures an inert mirror so typing never collapses the visible field. */
export const AutoTextarea = forwardRef<HTMLTextAreaElement, AutoTextareaProps>(
  function AutoTextarea(
    {
      className = "",
      rows = 1,
      maxAutoHeight = 240,
      value,
      defaultValue,
      placeholder,
      onInput,
      ...props
    },
    forwardedRef,
  ) {
    const element = useRef<HTMLTextAreaElement | null>(null);
    const measure = useRef(() => {});
    const metrics = useRef({ rows, maxAutoHeight });
    metrics.current = { rows, maxAutoHeight };
    const attach = useCallback((field: HTMLTextAreaElement | null) => {
      element.current = field;
      if (typeof forwardedRef === "function") forwardedRef(field);
      else if (forwardedRef) forwardedRef.current = field;
    }, [forwardedRef]);

    useLayoutEffect(() => {
      const field = element.current;
      if (!field) return;
      const mirror = document.createElement("textarea");
      mirror.setAttribute("aria-hidden", "true");
      mirror.setAttribute("data-autosize-mirror", "");
      mirror.tabIndex = -1;
      Object.assign(mirror.style, {
        position: "fixed",
        top: "0",
        left: "0",
        height: "0",
        minHeight: "0",
        maxHeight: "none",
        minWidth: "0",
        maxWidth: "none",
        visibility: "hidden",
        overflow: "hidden",
        resize: "none",
        pointerEvents: "none",
        zIndex: "-1",
        boxSizing: "border-box",
        whiteSpace: "pre-wrap",
      });
      document.body.append(mirror);
      let alive = true;
      let frame = 0;
      let lastWidth = -1;

      function resize() {
        if (!alive || !field) return;
        const width = field.getBoundingClientRect().width;
        // A hidden stage/disclosure has no useful wrapping width. Retain its
        // current height until ResizeObserver or toggle reports its reveal.
        if (width <= 0) return;
        const computed = getComputedStyle(field);
        for (const property of measurementProperties)
          mirror.style[property] = computed[property];
        const padding = pixels(computed.paddingTop) + pixels(computed.paddingBottom);
        const border = pixels(computed.borderTopWidth) + pixels(computed.borderBottomWidth);
        const horizontalInsets = pixels(computed.paddingLeft) + pixels(computed.paddingRight)
          + pixels(computed.borderLeftWidth) + pixels(computed.borderRightWidth);
        mirror.style.boxSizing = computed.boxSizing;
        mirror.style.width = `${computed.boxSizing === "border-box" ? width : width - horizontalInsets}px`;
        mirror.value = field.value || field.placeholder || " ";
        const lineHeight = pixels(computed.lineHeight) || pixels(computed.fontSize) * 1.5 || 20;
        const cap = Number.isFinite(metrics.current.maxAutoHeight)
          ? Math.max(1, metrics.current.maxAutoHeight)
          : 240;
        const minimum = Math.min(cap, Math.max(1, metrics.current.rows) * lineHeight + padding + border);
        const contentHeight = mirror.scrollHeight + border;
        const outerHeight = Math.ceil(Math.max(minimum, Math.min(cap, contentHeight)));
        const height = computed.boxSizing === "border-box"
          ? outerHeight
          : Math.max(0, outerHeight - padding - border);
        const next = `${height}px`;
        if (field.style.height !== next) field.style.height = next;
        field.style.overflowY = contentHeight > cap ? "auto" : "hidden";
      }

      function schedule() {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(resize);
      }

      measure.current = resize;
      const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver((entries) => {
        const width = entries[0]?.contentRect.width ?? 0;
        if (Math.abs(width - lastWidth) < 0.5) return;
        lastWidth = width;
        schedule();
      });
      observer?.observe(field);
      const reveal = (event: Event) => {
        if (event.target instanceof HTMLElement && event.target.contains(field)) schedule();
      };
      document.addEventListener("toggle", reveal, true);
      window.addEventListener("resize", schedule);
      void document.fonts?.ready.then(() => {
        if (alive) schedule();
      });
      resize();

      return () => {
        alive = false;
        measure.current = () => {};
        cancelAnimationFrame(frame);
        observer?.disconnect();
        document.removeEventListener("toggle", reveal, true);
        window.removeEventListener("resize", schedule);
        mirror.remove();
      };
    }, []);

    useLayoutEffect(() => {
      measure.current();
    }, [value, defaultValue, placeholder, rows, maxAutoHeight, className, props.style]);

    return (
      <textarea
        {...props}
        ref={attach}
        className={`gf-autosize-field${className ? ` ${className}` : ""}`}
        rows={rows}
        value={value}
        defaultValue={defaultValue}
        placeholder={placeholder}
        onInput={(event) => {
          onInput?.(event);
          measure.current();
        }}
      />
    );
  },
);
