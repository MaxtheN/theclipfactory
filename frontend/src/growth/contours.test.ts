import { describe, expect, it } from "vitest";
import { bufferPoint, contoursSupported, startContours } from "./contours";

describe("contour field renderer", () => {
  it("maps a viewport point into drawing-buffer pixels with y up", () => {
    const box = { left: 100, top: 50, width: 800, height: 400 };
    const size = { width: 1200, height: 600 };
    expect(bufferPoint({ x: 100, y: 50 }, box, size)).toEqual({ x: 0, y: 600 });
    expect(bufferPoint({ x: 500, y: 250 }, box, size)).toEqual({ x: 600, y: 300 });
    expect(bufferPoint({ x: 900, y: 450 }, box, size)).toEqual({ x: 1200, y: 0 });
  });

  it("stays off without WebGL, leaving the plain background", () => {
    expect(contoursSupported()).toBe(false);
    const host = document.createElement("div");
    expect(startContours(host)).toBeNull();
    expect(host.childElementCount).toBe(0);
  });
});
