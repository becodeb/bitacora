import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const validEnv = {
  DATABASE_URL: "postgresql://bitacora:bitacora@localhost:55432/bitacora",
  APP_TOKEN: "a-token-that-is-long-enough",
  PORT: "3000",
};

describe("loadConfig", () => {
  it("accepts a fully valid environment", () => {
    const config = loadConfig(validEnv);

    expect(config).toEqual({
      DATABASE_URL: validEnv.DATABASE_URL,
      APP_TOKEN: validEnv.APP_TOKEN,
      PORT: 3000,
    });
  });

  it("defaults PORT to 3000 when absent", () => {
    const { PORT, ...rest } = validEnv;
    const config = loadConfig(rest);

    expect(config.PORT).toBe(3000);
  });

  it("rejects a missing DATABASE_URL", () => {
    const { DATABASE_URL, ...rest } = validEnv;

    expect(() => loadConfig(rest)).toThrowError(/DATABASE_URL/);
  });

  it("rejects a missing APP_TOKEN", () => {
    const { APP_TOKEN, ...rest } = validEnv;

    expect(() => loadConfig(rest)).toThrowError(/APP_TOKEN/);
  });

  it("rejects an APP_TOKEN that is too short", () => {
    expect(() => loadConfig({ ...validEnv, APP_TOKEN: "short" })).toThrowError(/APP_TOKEN/);
  });

  it("rejects a non-numeric PORT", () => {
    expect(() => loadConfig({ ...validEnv, PORT: "not-a-number" })).toThrowError();
  });
});
