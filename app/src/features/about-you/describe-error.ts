import { ApiError, NetworkError } from "../../api/types";

/** Shared across this feature's containers (`use-topics.ts`, `use-topic-detail.ts`, `use-rules.ts`, `use-changes.ts`) — `use-chat.ts` keeps its own copy rather than importing across features, so this one stays local to `about-you` too. */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    return err.message;
  }
  if (err instanceof NetworkError) {
    return "network";
  }
  return err instanceof Error ? err.message : "unknown error";
}
