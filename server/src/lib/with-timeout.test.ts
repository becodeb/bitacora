import { describe, expect, it } from "vitest";
import { withTimeout } from "./with-timeout.js";

describe("withTimeout", () => {
  it("resolves with the original value when the promise settles first", async () => {
    const result = await withTimeout(Promise.resolve("value"), 50, "test");

    expect(result).toBe("value");
  });

  it("rejects with the original error when the promise rejects first", async () => {
    await expect(withTimeout(Promise.reject(new Error("boom")), 50, "test")).rejects.toThrow(
      "boom",
    );
  });

  it("rejects with a timeout error when the promise never settles", async () => {
    const neverSettles = new Promise<string>(() => {
      // Intentionally never resolves or rejects.
    });

    await expect(withTimeout(neverSettles, 20, "stuck-op")).rejects.toThrow(
      /stuck-op timed out after 20ms/,
    );
  });
});
