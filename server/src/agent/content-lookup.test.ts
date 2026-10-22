import { describe, expect, it } from "vitest";
import { HIT_TEXT_MAX_CHARS, truncateText } from "./content-lookup.js";

describe("truncateText", () => {
  it("returns short text unchanged", () => {
    expect(truncateText("hola")).toBe("hola");
  });

  it("truncates text longer than the default cap and appends a marker, never exceeding the cap", () => {
    const long = "a".repeat(HIT_TEXT_MAX_CHARS + 500);
    const result = truncateText(long);

    expect(result.length).toBeLessThanOrEqual(HIT_TEXT_MAX_CHARS);
    expect(result.endsWith("[truncated]")).toBe(true);
  });

  it("respects a custom max length as a true ceiling, marker included", () => {
    const result = truncateText("abcdefghijklmnopqrst", 15);
    expect(result.length).toBeLessThanOrEqual(15);
    expect(result.endsWith("[truncated]")).toBe(true);
    expect(result.startsWith("abc")).toBe(true);
  });
});
