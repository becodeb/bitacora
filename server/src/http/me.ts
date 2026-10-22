/**
 * `/v1/me`: the owner-facing memory API behind the "What I know about
 * you" screen (T10, `odd/tasks/mvp.md`'s owner decisions). Every route
 * here either reads what `memory/service.ts`/`memory/owner-view.ts`
 * already stored, or corrects it.
 *
 * Every mutation below generates a fresh `actionGroupId` right here
 * (never reused from an existing chat turn or consolidation run) and
 * goes through `memory/service.ts`, so each owner-made edit is its own
 * undoable group via `POST /v1/me/changes/:groupId/undo` — matching
 * `odd/tasks/mvp.md`'s "No confirmations ... with history and Undo"
 * decision. Mounted under the same bearer auth as the rest of `/v1`
 * (see `http/app.ts`).
 */
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import {
  getTopicOverview,
  listActiveRules,
  listChangeGroups,
  listLiveMemories,
  listTopicsOverview,
} from "../memory/owner-view.js";
import {
  correctMemoryContent,
  deactivateRule,
  invalidateMemoryManually,
  type MemoryServiceDeps,
  moveMemoryTopic,
  renameTopic,
  undoTurn,
  updateRule,
} from "../memory/service.js";

export type MeDeps = Pick<MemoryServiceDeps, "db" | "boss">;

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;
const DEFAULT_CHANGES_LIMIT = 20;
const MAX_CHANGES_LIMIT = 100;

const idParamSchema = z.object({ id: z.string().uuid() });
const keyParamSchema = z.object({ key: z.string().min(1) });
const groupIdParamSchema = z.object({ groupId: z.string().uuid() });

const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIST_LIMIT).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const listMemoriesQuerySchema = paginationQuerySchema.extend({
  topicId: z.union([z.literal("none"), z.string().uuid()]),
});

const patchMemoryBodySchema = z.union([
  z.object({ content: z.string().trim().min(1) }).strict(),
  z.object({ topicId: z.string().uuid().nullable() }).strict(),
]);

const patchTopicBodySchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    description: z.string().nullable().optional(),
  })
  .strict()
  .refine((data) => data.name !== undefined || data.description !== undefined, {
    message: "at least one of 'name' or 'description' is required",
  });

const putRuleBodySchema = z.object({
  payload: z.unknown(),
  topicName: z.string().trim().min(1).optional(),
});

const changesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_CHANGES_LIMIT).optional(),
});

/** Builds the `/v1/me` sub-router, mounted by `http/app.ts`. */
export function createMeRouter(deps: MeDeps): Hono {
  const router = new Hono();

  router.get("/topics", async (c) => {
    const overview = await listTopicsOverview(deps.db);
    return c.json({ ok: true, topics: overview }, 200);
  });

  router.get("/topics/:id", async (c) => {
    const params = idParamSchema.safeParse({ id: c.req.param("id") });
    if (!params.success) {
      return c.json({ ok: false, error: "id must be a UUID" }, 400);
    }
    const query = paginationQuerySchema.safeParse(c.req.query());
    if (!query.success) {
      return c.json({ ok: false, error: "invalid pagination parameters" }, 400);
    }

    const topic = await getTopicOverview(deps.db, params.data.id);
    if (!topic) {
      return c.json({ ok: false, error: "not found" }, 404);
    }

    const limit = query.data.limit ?? DEFAULT_LIST_LIMIT;
    const offset = query.data.offset ?? 0;
    const result = await listLiveMemories(deps.db, { topicId: params.data.id, limit, offset });

    return c.json(
      { ok: true, topic, memories: result.memories, total: result.total, limit, offset },
      200,
    );
  });

  router.patch("/topics/:id", async (c) => {
    const params = idParamSchema.safeParse({ id: c.req.param("id") });
    if (!params.success) {
      return c.json({ ok: false, error: "id must be a UUID" }, 400);
    }

    const json = await c.req.json().catch(() => null);
    const body = patchTopicBodySchema.safeParse(json);
    if (!body.success) {
      return c.json({ ok: false, error: "body must include 'name' and/or 'description'" }, 400);
    }

    const turnId = randomUUID();
    const result = await renameTopic(deps, {
      topicId: params.data.id,
      name: body.data.name,
      description: body.data.description,
      turnId,
    });
    if (result === "not_found") {
      return c.json({ ok: false, error: "not found" }, 404);
    }
    if (result === "conflict") {
      return c.json({ ok: false, error: "a topic with that name already exists" }, 409);
    }
    return c.json({ ok: true, groupId: turnId, topic: result.topic }, 200);
  });

  router.get("/memories", async (c) => {
    const query = listMemoriesQuerySchema.safeParse(c.req.query());
    if (!query.success) {
      return c.json({ ok: false, error: "topicId must be 'none' or a UUID" }, 400);
    }

    if (query.data.topicId !== "none") {
      const topic = await getTopicOverview(deps.db, query.data.topicId);
      if (!topic) {
        return c.json({ ok: false, error: "topic not found" }, 404);
      }
    }

    const limit = query.data.limit ?? DEFAULT_LIST_LIMIT;
    const offset = query.data.offset ?? 0;
    const result = await listLiveMemories(deps.db, { topicId: query.data.topicId, limit, offset });
    return c.json({ ok: true, memories: result.memories, total: result.total, limit, offset }, 200);
  });

  router.patch("/memories/:id", async (c) => {
    const params = idParamSchema.safeParse({ id: c.req.param("id") });
    if (!params.success) {
      return c.json({ ok: false, error: "id must be a UUID" }, 400);
    }

    const json = await c.req.json().catch(() => null);
    const body = patchMemoryBodySchema.safeParse(json);
    if (!body.success) {
      return c.json(
        { ok: false, error: "body must be exactly one of { content } or { topicId }" },
        400,
      );
    }

    const turnId = randomUUID();

    if ("content" in body.data) {
      const result = await correctMemoryContent(deps, {
        memoryId: params.data.id,
        content: body.data.content,
        turnId,
      });
      if (result === "not_found") {
        return c.json({ ok: false, error: "not found" }, 404);
      }
      return c.json({ ok: true, groupId: turnId, ...result }, 200);
    }

    const result = await moveMemoryTopic(deps, {
      memoryId: params.data.id,
      topicId: body.data.topicId,
      turnId,
    });
    if (result === "not_found") {
      return c.json({ ok: false, error: "not found" }, 404);
    }
    if (result === "topic_not_found") {
      return c.json({ ok: false, error: "topic not found" }, 404);
    }
    return c.json({ ok: true, groupId: turnId, ...result }, 200);
  });

  router.delete("/memories/:id", async (c) => {
    const params = idParamSchema.safeParse({ id: c.req.param("id") });
    if (!params.success) {
      return c.json({ ok: false, error: "id must be a UUID" }, 400);
    }

    const turnId = randomUUID();
    const result = await invalidateMemoryManually(deps, { memoryId: params.data.id, turnId });
    if (result === "not_found") {
      return c.json({ ok: false, error: "not found" }, 404);
    }
    return c.json({ ok: true, groupId: turnId, memoryId: result.memoryId }, 200);
  });

  router.get("/rules", async (c) => {
    const rulesList = await listActiveRules(deps.db);
    return c.json({ ok: true, rules: rulesList }, 200);
  });

  router.put("/rules/:key", async (c) => {
    const params = keyParamSchema.safeParse({ key: c.req.param("key") });
    if (!params.success) {
      return c.json({ ok: false, error: "key is required" }, 400);
    }

    const json = await c.req.json().catch(() => null);
    const body = putRuleBodySchema.safeParse(json);
    if (!body.success) {
      return c.json({ ok: false, error: "body must include 'payload'" }, 400);
    }

    const turnId = randomUUID();
    const result = await updateRule(deps, {
      key: params.data.key,
      payload: body.data.payload,
      topicName: body.data.topicName,
      turnId,
      source: "manual_edit",
    });
    return c.json({ ok: true, groupId: turnId, ruleId: result.ruleId, action: result.action }, 200);
  });

  router.delete("/rules/:key", async (c) => {
    const params = keyParamSchema.safeParse({ key: c.req.param("key") });
    if (!params.success) {
      return c.json({ ok: false, error: "key is required" }, 400);
    }

    const turnId = randomUUID();
    const result = await deactivateRule(deps, { key: params.data.key, turnId });
    if (result === "not_found") {
      return c.json({ ok: false, error: "not found" }, 404);
    }
    return c.json({ ok: true, groupId: turnId, ruleId: result.ruleId }, 200);
  });

  router.get("/changes", async (c) => {
    const query = changesQuerySchema.safeParse(c.req.query());
    if (!query.success) {
      return c.json({ ok: false, error: "invalid 'limit'" }, 400);
    }

    const limit = query.data.limit ?? DEFAULT_CHANGES_LIMIT;
    const changes = await listChangeGroups(deps.db, limit);
    return c.json({ ok: true, changes }, 200);
  });

  router.post("/changes/:groupId/undo", async (c) => {
    const params = groupIdParamSchema.safeParse({ groupId: c.req.param("groupId") });
    if (!params.success) {
      return c.json({ ok: false, error: "groupId must be a UUID" }, 400);
    }

    const result = await undoTurn(deps, params.data.groupId);
    return c.json({ ok: true, turnId: result.turnId, reverted: result.revertedCount }, 200);
  });

  return router;
}
