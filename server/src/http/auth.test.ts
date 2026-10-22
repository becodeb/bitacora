import { describe, expect, it } from "vitest";
import { createStubAgentDeps } from "../agent/test-helpers.js";
import { createStubIngestDeps } from "../ingestion/test-helpers.js";
import { createApp } from "./app.js";
import { createStubAdminJobsDeps } from "./test-helpers.js";

const APP_TOKEN = "correct-token-0123456789";

function buildApp() {
  return createApp({
    appToken: APP_TOKEN,
    checkDb: async () => true,
    ingest: createStubIngestDeps(),
    agent: createStubAgentDeps(),
    adminJobs: createStubAdminJobsDeps(),
  });
}

describe("bearer auth on /v1", () => {
  it("rejects a request with no Authorization header", async () => {
    const app = buildApp();
    const res = await app.request("/v1/me");

    expect(res.status).toBe(401);
  });

  it("rejects a request with the wrong token", async () => {
    const app = buildApp();
    const res = await app.request("/v1/me", {
      headers: { Authorization: "Bearer wrong-token" },
    });

    expect(res.status).toBe(401);
  });

  it("rejects a wrong token of a different length than the real one", async () => {
    const app = buildApp();
    const res = await app.request("/v1/me", {
      headers: { Authorization: "Bearer short" },
    });

    expect(res.status).toBe(401);
  });

  it("rejects a double space between the scheme and the token", async () => {
    const app = buildApp();
    const res = await app.request("/v1/me", {
      headers: { Authorization: `Bearer  ${APP_TOKEN}` },
    });

    expect(res.status).toBe(401);
  });

  it("accepts a lowercase 'bearer' scheme, per RFC 7235 case-insensitivity", async () => {
    const app = buildApp();
    const res = await app.request("/v1/me", {
      headers: { Authorization: `bearer ${APP_TOKEN}` },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it("accepts a request with the right token", async () => {
    const app = buildApp();
    const res = await app.request("/v1/me", {
      headers: { Authorization: `Bearer ${APP_TOKEN}` },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it("does not require a token for /health", async () => {
    const app = buildApp();
    const res = await app.request("/health");

    expect(res.status).toBe(200);
  });

  it("rejects HEAD on /v1/me without a token", async () => {
    const app = buildApp();
    const res = await app.request("/v1/me", { method: "HEAD" });

    expect(res.status).toBe(401);
  });

  it("rejects OPTIONS on /v1/me without a token", async () => {
    const app = buildApp();
    const res = await app.request("/v1/me", { method: "OPTIONS" });

    expect(res.status).toBe(401);
  });

  describe("an unknown path under /v1", () => {
    it("gives 401 without a token, since auth runs before routing", async () => {
      const app = buildApp();
      const res = await app.request("/v1/does-not-exist");

      expect(res.status).toBe(401);
    });

    it("gives 404 with the right token, since auth passes but no route matches", async () => {
      const app = buildApp();
      const res = await app.request("/v1/does-not-exist", {
        headers: { Authorization: `Bearer ${APP_TOKEN}` },
      });

      expect(res.status).toBe(404);
    });
  });
});
