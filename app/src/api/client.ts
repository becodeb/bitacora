import { fetch as expoFetch } from "expo/fetch";
import { consumeChatStream } from "./sse";
import {
  ApiError,
  type ChatHistoryResponse,
  type ChatStreamEvent,
  type EntryResponse,
  type MeChangesResponse,
  type MeMemoriesResponse,
  type MeMutationResponse,
  type MeRulesResponse,
  type MeTopicDetailResponse,
  type MeTopicsResponse,
  type MeUndoResponse,
  NetworkError,
  type UndoResponse,
} from "./types";

export interface ApiClientConfig {
  baseUrl: string;
  token: string;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

async function parseJsonOrThrow<T>(response: Response): Promise<T> {
  const text = await response.text();
  let body: unknown;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : `request failed with status ${response.status}`;
    throw new ApiError(response.status, message);
  }

  return body as T;
}

/** Wraps a fetch call so any transport-level failure (DNS, timeout, TLS, connection refused) becomes a typed `NetworkError` instead of leaking fetch's own untyped `TypeError`. */
async function guardedFetch(
  input: string,
  init: Parameters<typeof expoFetch>[1],
): Promise<Response> {
  try {
    return await expoFetch(input, init);
  } catch (error) {
    throw new NetworkError(error instanceof Error ? error.message : "network request failed");
  }
}

/**
 * Thin typed client for Bitacora's server (`server/src/http/*.ts`).
 * Holds no state beyond `baseUrl`/`token`; callers (the settings and
 * chat containers) own when a new instance is built and when requests
 * are retried.
 */
export class ApiClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(config: ApiClientConfig) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.token = config.token;
  }

  private authHeaders(extra?: Record<string, string>): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, ...extra };
  }

  /** `GET /health` — unauthenticated. Returns false on any network failure or non-2xx, rather than throwing, since this is only ever used as a yes/no probe. */
  async checkHealth(): Promise<boolean> {
    try {
      const response = await guardedFetch(`${this.baseUrl}/health`, { method: "GET" });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** `GET /v1/me` — used to validate the token during onboarding/settings. Returns true only on a 200; a 401 or network failure both resolve false (callers that need to distinguish should use `checkHealth` first). */
  async checkAuth(): Promise<boolean> {
    try {
      const response = await guardedFetch(`${this.baseUrl}/v1/me`, {
        method: "GET",
        headers: this.authHeaders(),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async getChatHistory(limit?: number): Promise<ChatHistoryResponse> {
    const query = limit ? `?limit=${limit}` : "";
    const response = await guardedFetch(`${this.baseUrl}/v1/chat/history${query}`, {
      method: "GET",
      headers: this.authHeaders(),
    });
    return parseJsonOrThrow<ChatHistoryResponse>(response);
  }

  async undoLast(): Promise<UndoResponse> {
    const response = await guardedFetch(`${this.baseUrl}/v1/chat/undo`, {
      method: "POST",
      headers: this.authHeaders(),
    });
    return parseJsonOrThrow<UndoResponse>(response);
  }

  async getEntry(entryId: string): Promise<EntryResponse> {
    const response = await guardedFetch(`${this.baseUrl}/v1/entries/${entryId}`, {
      method: "GET",
      headers: this.authHeaders(),
    });
    return parseJsonOrThrow<EntryResponse>(response);
  }

  /**
   * Opens `POST /v1/chat` for a plain text turn and streams its SSE
   * events to `onEvent`. A non-2xx response (the server responds with
   * a plain JSON error before opening the stream for a bad request —
   * see `chat.ts`'s `ChatInputError`) is parsed and thrown as
   * `ApiError` instead of being handed to the SSE decoder.
   */
  async sendTextMessage(text: string, onEvent: (event: ChatStreamEvent) => void): Promise<void> {
    const response = await guardedFetch(`${this.baseUrl}/v1/chat`, {
      method: "POST",
      headers: this.authHeaders({
        "content-type": "application/json",
        accept: "text/event-stream",
      }),
      body: JSON.stringify({ text }),
    });
    await this.consumeOrThrow(response, onEvent);
  }

  /** Same as `sendTextMessage`, but for a turn about an entry already ingested (e.g. a shared photo). */
  async sendEntryMessage(
    entryId: string,
    onEvent: (event: ChatStreamEvent) => void,
  ): Promise<void> {
    const response = await guardedFetch(`${this.baseUrl}/v1/chat`, {
      method: "POST",
      headers: this.authHeaders({
        "content-type": "application/json",
        accept: "text/event-stream",
      }),
      body: JSON.stringify({ entryId }),
    });
    await this.consumeOrThrow(response, onEvent);
  }

  /**
   * Sends a photo or voice attachment (with an optional caption) as a
   * chat turn, multipart — same field names `server/src/http/chat.ts`
   * expects for its own `resolveEntryId` multipart branch: `file` and,
   * when present, `caption`. Streams the answer exactly like
   * `sendTextMessage`.
   */
  async sendAttachmentMessage(
    attachment: { uri: string; mimeType: string; fileName: string },
    caption: string | undefined,
    onEvent: (event: ChatStreamEvent) => void,
  ): Promise<void> {
    const form = new FormData();
    // React Native's FormData accepts this `{ uri, name, type }` shape
    // for a file part — not a real `Blob`/`File` — and `expo/fetch`
    // honors it the same way `fetch` does elsewhere in the app.
    form.append(
      "file",
      {
        uri: attachment.uri,
        name: attachment.fileName,
        type: attachment.mimeType,
      } as unknown as Blob,
      attachment.fileName,
    );
    if (caption && caption.trim().length > 0) {
      form.append("caption", caption.trim());
    }

    const response = await guardedFetch(`${this.baseUrl}/v1/chat`, {
      method: "POST",
      headers: this.authHeaders({ accept: "text/event-stream" }),
      body: form as unknown as BodyInit,
    });
    await this.consumeOrThrow(response, onEvent);
  }

  // --- "What I know about you" (server/src/http/me.ts, T10 work unit (c)) ---

  async getTopics(): Promise<MeTopicsResponse> {
    const response = await guardedFetch(`${this.baseUrl}/v1/me/topics`, {
      method: "GET",
      headers: this.authHeaders(),
    });
    return parseJsonOrThrow<MeTopicsResponse>(response);
  }

  async getTopic(topicId: string): Promise<MeTopicDetailResponse> {
    const response = await guardedFetch(`${this.baseUrl}/v1/me/topics/${topicId}`, {
      method: "GET",
      headers: this.authHeaders(),
    });
    return parseJsonOrThrow<MeTopicDetailResponse>(response);
  }

  async renameTopic(
    topicId: string,
    patch: { name?: string; description?: string | null },
  ): Promise<MeMutationResponse> {
    const response = await guardedFetch(`${this.baseUrl}/v1/me/topics/${topicId}`, {
      method: "PATCH",
      headers: this.authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(patch),
    });
    return parseJsonOrThrow<MeMutationResponse>(response);
  }

  async getMemoriesWithoutTopic(): Promise<MeMemoriesResponse> {
    const response = await guardedFetch(`${this.baseUrl}/v1/me/memories?topicId=none`, {
      method: "GET",
      headers: this.authHeaders(),
    });
    return parseJsonOrThrow<MeMemoriesResponse>(response);
  }

  async correctMemoryContent(memoryId: string, content: string): Promise<MeMutationResponse> {
    const response = await guardedFetch(`${this.baseUrl}/v1/me/memories/${memoryId}`, {
      method: "PATCH",
      headers: this.authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ content }),
    });
    return parseJsonOrThrow<MeMutationResponse>(response);
  }

  async moveMemoryTopic(memoryId: string, topicId: string | null): Promise<MeMutationResponse> {
    const response = await guardedFetch(`${this.baseUrl}/v1/me/memories/${memoryId}`, {
      method: "PATCH",
      headers: this.authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ topicId }),
    });
    return parseJsonOrThrow<MeMutationResponse>(response);
  }

  async deleteMemory(memoryId: string): Promise<MeMutationResponse> {
    const response = await guardedFetch(`${this.baseUrl}/v1/me/memories/${memoryId}`, {
      method: "DELETE",
      headers: this.authHeaders(),
    });
    return parseJsonOrThrow<MeMutationResponse>(response);
  }

  async getRules(): Promise<MeRulesResponse> {
    const response = await guardedFetch(`${this.baseUrl}/v1/me/rules`, {
      method: "GET",
      headers: this.authHeaders(),
    });
    return parseJsonOrThrow<MeRulesResponse>(response);
  }

  async putRule(key: string, payload: unknown, topicName?: string): Promise<MeMutationResponse> {
    const response = await guardedFetch(`${this.baseUrl}/v1/me/rules/${encodeURIComponent(key)}`, {
      method: "PUT",
      headers: this.authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ payload, topicName }),
    });
    return parseJsonOrThrow<MeMutationResponse>(response);
  }

  async deleteRule(key: string): Promise<MeMutationResponse> {
    const response = await guardedFetch(`${this.baseUrl}/v1/me/rules/${encodeURIComponent(key)}`, {
      method: "DELETE",
      headers: this.authHeaders(),
    });
    return parseJsonOrThrow<MeMutationResponse>(response);
  }

  async getChanges(limit?: number): Promise<MeChangesResponse> {
    const query = limit ? `?limit=${limit}` : "";
    const response = await guardedFetch(`${this.baseUrl}/v1/me/changes${query}`, {
      method: "GET",
      headers: this.authHeaders(),
    });
    return parseJsonOrThrow<MeChangesResponse>(response);
  }

  async undoChangeGroup(groupId: string): Promise<MeUndoResponse> {
    const response = await guardedFetch(`${this.baseUrl}/v1/me/changes/${groupId}/undo`, {
      method: "POST",
      headers: this.authHeaders(),
    });
    return parseJsonOrThrow<MeUndoResponse>(response);
  }

  private async consumeOrThrow(
    response: Response,
    onEvent: (event: ChatStreamEvent) => void,
  ): Promise<void> {
    if (!response.ok) {
      await parseJsonOrThrow(response);
      return;
    }
    if (!response.body) {
      throw new NetworkError("the server response had no readable body");
    }
    await consumeChatStream(response.body, onEvent);
  }
}
