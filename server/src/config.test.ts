import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const validEnv = {
  DATABASE_URL: "postgresql://bitacora:bitacora@localhost:55432/bitacora",
  APP_TOKEN: "a-token-that-is-long-enough",
  PORT: "3000",
  GROQ_API_KEY: "a-fake-groq-key",
  VOYAGE_API_KEY: "a-fake-voyage-key",
  ANTHROPIC_API_KEY: "a-fake-anthropic-key",
  DATA_DIR: "./data",
};

describe("loadConfig", () => {
  it("accepts a fully valid environment", () => {
    const config = loadConfig(validEnv);

    expect(config).toEqual({
      DATABASE_URL: validEnv.DATABASE_URL,
      APP_TOKEN: validEnv.APP_TOKEN,
      PORT: 3000,
      GROQ_API_KEY: validEnv.GROQ_API_KEY,
      VOYAGE_API_KEY: validEnv.VOYAGE_API_KEY,
      ANTHROPIC_API_KEY: validEnv.ANTHROPIC_API_KEY,
      AGENT_EFFORT: "low",
      DATA_DIR: validEnv.DATA_DIR,
    });
  });

  it("defaults PORT to 3000 when absent", () => {
    const { PORT, ...rest } = validEnv;
    const config = loadConfig(rest);

    expect(config.PORT).toBe(3000);
  });

  it("defaults DATA_DIR to ./data when absent", () => {
    const { DATA_DIR, ...rest } = validEnv;
    const config = loadConfig(rest);

    expect(config.DATA_DIR).toBe("./data");
  });

  it("rejects a missing GROQ_API_KEY", () => {
    const { GROQ_API_KEY, ...rest } = validEnv;

    expect(() => loadConfig(rest)).toThrowError(/GROQ_API_KEY/);
  });

  it("rejects a missing VOYAGE_API_KEY", () => {
    const { VOYAGE_API_KEY, ...rest } = validEnv;

    expect(() => loadConfig(rest)).toThrowError(/VOYAGE_API_KEY/);
  });

  it("rejects a missing ANTHROPIC_API_KEY", () => {
    const { ANTHROPIC_API_KEY, ...rest } = validEnv;

    expect(() => loadConfig(rest)).toThrowError(/ANTHROPIC_API_KEY/);
  });

  it("defaults AGENT_EFFORT to low when absent", () => {
    const config = loadConfig(validEnv);
    expect(config.AGENT_EFFORT).toBe("low");
  });

  it("rejects an invalid AGENT_EFFORT", () => {
    expect(() => loadConfig({ ...validEnv, AGENT_EFFORT: "extreme" })).toThrowError();
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
