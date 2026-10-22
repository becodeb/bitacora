import { type Context, Hono } from "hono";
import { z } from "zod";
import {
  createAttachmentEntry,
  createTextEntry,
  getEntryById,
  type IngestDeps,
} from "../ingestion/entries.js";
import { classifyAttachmentMime } from "../ingestion/mime.js";

const MULTIPART_CONTENT_TYPE_PREFIX = "multipart/form-data";

const entryIdParamSchema = z.object({ id: z.string().uuid() });
const jsonTextBodySchema = z.object({ text: z.string().trim().min(1) });

/**
 * Builds the `/v1/entries` sub-router. `deps` is the same shape the
 * derivation jobs use (`IngestDeps`), so the app composes one set of
 * ingestion dependencies and shares it between the HTTP layer and the
 * pg-boss workers.
 */
export function createEntriesRouter(deps: IngestDeps): Hono {
  const router = new Hono();

  router.post("/", async (c) => {
    const contentType = c.req.header("content-type") ?? "";

    if (contentType.toLowerCase().startsWith(MULTIPART_CONTENT_TYPE_PREFIX)) {
      return handleMultipart(c, deps);
    }

    return handleJsonText(c, deps);
  });

  router.get("/:id", async (c) => {
    const parsedParams = entryIdParamSchema.safeParse({ id: c.req.param("id") });
    if (!parsedParams.success) {
      return c.json({ ok: false, error: "id must be a UUID" }, 400);
    }

    const entry = await getEntryById(deps, parsedParams.data.id);
    if (!entry) {
      return c.json({ ok: false, error: "not found" }, 404);
    }

    return c.json({ ok: true, entry }, 200);
  });

  return router;
}

async function handleJsonText(c: Context, deps: IngestDeps): Promise<Response> {
  const json = await c.req.json().catch(() => null);
  const parsed = jsonTextBodySchema.safeParse(json);
  if (!parsed.success) {
    return c.json(
      { ok: false, error: "JSON body must include a non-empty 'text' string field" },
      400,
    );
  }

  const created = await createTextEntry(deps, parsed.data.text);
  return c.json({ ok: true, id: created.entryId, kind: created.kind, status: "stored" }, 201);
}

async function handleMultipart(c: Context, deps: IngestDeps): Promise<Response> {
  const body = await c.req.parseBody();
  const file = body.file;

  if (file instanceof File) {
    return handleAttachment(
      c,
      deps,
      file,
      typeof body.caption === "string" ? body.caption : undefined,
    );
  }

  const text = body.text;
  if (typeof text === "string" && text.trim().length > 0) {
    const created = await createTextEntry(deps, text);
    return c.json({ ok: true, id: created.entryId, kind: created.kind, status: "stored" }, 201);
  }

  return c.json(
    { ok: false, error: "multipart body must include a 'file' part or a non-empty 'text' field" },
    400,
  );
}

async function handleAttachment(
  c: Context,
  deps: IngestDeps,
  file: File,
  caption: string | undefined,
): Promise<Response> {
  const classification = classifyAttachmentMime(file.type);
  if (!classification) {
    return c.json({ ok: false, error: `unsupported mime type: ${file.type || "(empty)"}` }, 415);
  }

  if (file.size > classification.maxBytes) {
    return c.json(
      {
        ok: false,
        error: `file too large: ${file.size} bytes exceeds the ${classification.maxBytes}-byte limit for ${classification.kind}`,
      },
      413,
    );
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const created = await createAttachmentEntry(deps, classification.kind, file.type, bytes, caption);

  return c.json(
    {
      ok: true,
      id: created.entryId,
      kind: created.kind,
      status: "stored",
      attachment: created.attachment,
    },
    201,
  );
}
