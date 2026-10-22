/**
 * `POST /v1/chat`: the SSE chat endpoint. Reuses `/v1/entries`'
 * ingestion (`ingestion/entries.ts`) so every chat message — text,
 * photo, or voice — is also stored as a raw-log entry, then runs one
 * agent turn (`agent/run-turn.ts`) and streams its progress.
 */
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { listChatHistory } from "../agent/chat-history.js";
import type { AgentTurnDeps } from "../agent/run-turn.js";
import { runAgentTurn } from "../agent/run-turn.js";
import {
  createAttachmentEntry,
  createTextEntry,
  getEntryById,
  type IngestDeps,
} from "../ingestion/entries.js";
import { classifyAttachmentMime, MAX_REQUEST_BODY_BYTES } from "../ingestion/mime.js";
import { undoLast } from "../memory/service.js";

const MULTIPART_CONTENT_TYPE_PREFIX = "multipart/form-data";

export interface ChatDeps {
  ingest: IngestDeps;
  agent: AgentTurnDeps;
}

class ChatInputError extends Error {
  constructor(
    public status: 400 | 404 | 413 | 415,
    message: string,
  ) {
    super(message);
  }
}

const jsonBodySchema = z.union([
  z.object({ text: z.string().trim().min(1) }),
  z.object({ entryId: z.string().uuid() }),
]);

/** Resolves (creating, when needed) the entry this chat turn is about, from any of the three accepted body shapes. Throws `ChatInputError` on anything invalid, so the caller can respond before opening the SSE stream. */
async function resolveEntryId(c: Context, deps: ChatDeps): Promise<string> {
  const contentType = c.req.header("content-type") ?? "";

  if (contentType.toLowerCase().startsWith(MULTIPART_CONTENT_TYPE_PREFIX)) {
    const body = await c.req.parseBody();
    const file = body.file;

    if (file instanceof File) {
      const classification = classifyAttachmentMime(file.type);
      if (!classification) {
        throw new ChatInputError(415, `unsupported mime type: ${file.type || "(empty)"}`);
      }
      if (file.size > classification.maxBytes) {
        throw new ChatInputError(
          413,
          `file too large: ${file.size} bytes exceeds the ${classification.maxBytes}-byte limit for ${classification.kind}`,
        );
      }
      const bytes = Buffer.from(await file.arrayBuffer());
      const caption = typeof body.caption === "string" ? body.caption : undefined;
      const created = await createAttachmentEntry(
        deps.ingest,
        classification.kind,
        file.type,
        bytes,
        caption,
      );
      return created.entryId;
    }

    const text = body.text;
    if (typeof text === "string" && text.trim().length > 0) {
      const created = await createTextEntry(deps.ingest, text);
      return created.entryId;
    }

    throw new ChatInputError(
      400,
      "multipart body must include a 'file' part or a non-empty 'text' field",
    );
  }

  const json = await c.req.json().catch(() => null);
  const parsed = jsonBodySchema.safeParse(json);
  if (!parsed.success) {
    throw new ChatInputError(
      400,
      "JSON body must include either a non-empty 'text' string or an 'entryId' UUID",
    );
  }

  if ("text" in parsed.data) {
    const created = await createTextEntry(deps.ingest, parsed.data.text);
    return created.entryId;
  }

  const entry = await getEntryById(deps.ingest, parsed.data.entryId);
  if (!entry) {
    throw new ChatInputError(404, "entryId not found");
  }
  return entry.id;
}

export function createChatRouter(deps: ChatDeps): Hono {
  const router = new Hono();

  const limitBody = bodyLimit({
    maxSize: MAX_REQUEST_BODY_BYTES,
    onError: (c) => c.json({ ok: false, error: "request body too large" }, 413),
  });

  router.post("/", limitBody, async (c) => {
    let entryId: string;
    try {
      entryId = await resolveEntryId(c, deps);
    } catch (error) {
      if (error instanceof ChatInputError) {
        return c.json({ ok: false, error: error.message }, error.status);
      }
      throw error;
    }

    return streamSSE(
      c,
      async (stream) => {
        const result = await runAgentTurn(deps.agent, {
          entryId,
          onTextDelta: (text) => {
            void stream.writeSSE({ event: "text", data: text });
          },
          onToolEvent: (event) => {
            void stream.writeSSE({ event: "tool", data: JSON.stringify(event) });
          },
        });

        for (const citation of result.citations) {
          await stream.writeSSE({ event: "citations", data: JSON.stringify(citation) });
        }

        await stream.writeSSE({
          event: "done",
          data: JSON.stringify({
            turnId: result.turnId,
            stopReason: result.stopReason,
            usage: result.usage,
            derivationPending: result.derivationPending,
          }),
        });
      },
      // Always emits a `data`-bearing `error` event on an uncaught
      // exception inside the callback above (see hono's `streamSSE`
      // helper); logging here is just for the server's own visibility.
      async (error) => {
        console.error("chat turn failed:", error);
      },
    );
  });

  router.post("/undo", async (c) => {
    const result = await undoLast(deps.agent.memory);
    if (!result) {
      return c.json({ ok: true, reverted: 0 }, 200);
    }
    return c.json({ ok: true, turnId: result.turnId, reverted: result.revertedCount }, 200);
  });

  router.get("/history", async (c) => {
    const limitParam = c.req.query("limit");
    const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;
    const messages = await listChatHistory(
      deps.agent.db,
      Number.isFinite(limit) && limit && limit > 0 ? limit : undefined,
    );
    return c.json({ ok: true, messages }, 200);
  });

  return router;
}
