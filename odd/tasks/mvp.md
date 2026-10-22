# Feature: Bitacora MVP

- Locator: `odd/tasks/mvp.md` in repo `bitacora` (local path `~/projects/bitacora`).
- Engram mirror: project `bitacora`, topic `odd/mvp/tasks`.
- Revision 4 (2026-10-22). The plan pivoted to "an AI that knows everything about me". Recorded conversations moved to stage 4.

## Objective

A personal AI assistant that knows the owner. It has two parts: an Android app with a chat, and a server with memory.

- **Inputs** are whatever the owner sends: text, photos (screenshots), and voice notes. Recorded conversations are added later as one more input.
- **Memory.** The AI remembers facts, preferences and how the owner wants things done.
- **Calendar.** It manages Google Calendar.
- **Initiative.** It acts on its own initiative, within limits.

## Problem

The owner wants one place to dump everything: thoughts, things to remember, exam dates, what other people said. It should be organized automatically, using what the AI already knows about them.

Canonical example:

- The owner sends a screenshot of exam dates. The AI knows the owner studies "Sistemas", so it schedules only those exams and reports the ones it ignored, such as "Mecánica".
- If the photo does not say the subject, the owner can say later "that photo was from Análisis". The AI then finds it, fixes the events and remembers.

## Why

This is a personal tool. It succeeds if the owner keeps using it, because it gives value back without being asked.

## Owner decisions (2026-10-22)

- **Platform.** An own Android app, not Telegram. Comfort features:
  - an Android share target ("Share with Bitacora");
  - widgets: quick note, today, and later record;
  - replying from notifications.
- **Two screens.**
  - Chat: text, photos and voice.
  - "What I know about you": view and correct topics and rules.
  - The calendar is Google Calendar itself.
- **No confirmations.** The AI applies changes automatically, with history and Undo. It asks only when it cannot resolve something.
- **Context.** Nothing about the owner is loaded by default; everything is dynamic. Even the owner's degree enters context only when the message relates to it.
- **Google Calendar is the priority** after the chat and memory.
- **Images.** Extract the text locally first. Test whether OCR text alone is enough, compared with Haiku vision. Vision is kept wherever OCR loses meaning, for example which date goes with which subject in a table.
- Legal constraints are waived. Storing voiceprints is OK (stage 4).
- UI copy defaults to English and the owner may switch it. AI content is in Rioplatense Spanish.

## Memory design

This design is based on research done 2026-10-22. Anthropic's context-engineering guidance calls for just-in-time context and progressive disclosure. Production systems (ChatGPT, OpenClaw, Letta, Zep) are all hybrids of automatic retrieval and tool retrieval.

Stores, all in Postgres:

- **Raw log.** Everything the owner sends, immutable: text, photo files, audio files, plus the OCR text and transcripts derived from them.
- **Topics.** Named groups of memories: "University", "Work", "Juan", and so on.
- **Memories.** Atomic facts, each with a source entry, a validity window and a `supersedes` link.
- **Rules.** Structured templates, such as an event title format or reminder lead times. Server code applies them when a tool runs, so they cost no context.
- **Change log.** Used for Undo.
- **Daily rollups.** These make up the diary.

Per-message flow:

1. **Store the entry.** Photos get OCR text; voice gets a Groq transcript.
2. **Automatic pre-search.**
   - It runs over memories, topics and the raw log.
   - Search is hybrid: Spanish FTS, Voyage embeddings in pgvector, and `pg_trgm` for typo tolerance, combined with RRF.
   - Results above a relevance threshold become "possible topics / memories" hints.
   - Below the threshold, nothing is added.
3. **Haiku 5.5 runs with:**
   - behavior instructions;
   - the list of topic names only;
   - the hints;
   - tools: open topic, search, remember, update rule, calendar tools (stage 2), and undo.
4. **Write with dedup.** A new fact is compared against similar ones: ADD, UPDATE (supersede) or NOOP.
5. **Nightly consolidation.** Merge duplicates and summarize old material.

Known risks:

- There is no published evidence of how Haiku 5.5 does at triggering memory tools; the pre-search hints are the mitigation.
- Vendor memory benchmarks (Mem0 vs Zep) are disputed, so measure inside the app.

## Architecture

- **Server.** Node 24 and TypeScript, with Hono, Drizzle and PostgreSQL. The pgvector image is used, with `pg_trgm`. Also pg-boss, Vitest and Biome.
  - Deployed on the becode Coolify at `bitacora.becode.com.ar`, with daily backups.
  - Auth is a single bearer token.
- **LLM.** Claude Haiku 5.5 (`claude-haiku-5-5`). Pricing is $0.10 / $0.50 per MTok for prompts under 100K tokens and 5x above, so every call stays under 100K. Use the official `@anthropic-ai/sdk`.
- **Embeddings.** Voyage AI, which Anthropic recommends. Anthropic has no embedding model.
- **Voice notes.** Groq `whisper-large-v3-turbo`, which is the T02 adapter. Record into `.m4a` (MPEG-4/AAC), because Groq does not accept raw AAC.
- **OCR.** Runs locally on the server; the engine is chosen in T07.
- **App.** An Expo (TypeScript) dev build for Android, built as an APK through EAS. Native pieces as needed: the share target and widgets now, the microphone foreground service in stage 4.

## Scope

In: tasks T01–T20.

Out:

- iPhone;
- web UI;
- multi-user;
- TTS.

## Owner inputs needed

| When | Input |
|---|---|
| Done | `~/.credentials/bitacora.env` with `ANTHROPIC_API_KEY`, `GROQ_API_KEY` and `VOYAGE_API_KEY`. All three answered 200 on 2026-10-22. |
| T05 | A payment method on the Voyage account, to lift the 3 requests/min limit. The 200M free tokens still apply. |
| T10 | An Expo account. |
| T11 | Authorization to create the GitHub repo, push and deploy. |
| T12 | A Google Cloud project for OAuth. Publish it to "Production", because tokens expire after 7 days in Testing. |
| T14 | A Firebase project for push. |
| T17 | AssemblyAI and Speechmatics keys, plus three real recordings in `samples/` (gitignored). |

## Development mode

- **TDD: off.** Nothing is configured and the owner made no choice, so this is the default. Ordinary checks apply, and server logic still ships with tests in the same work unit. The runner is Vitest (`npm test` in `server/`).
- **RDD: off globally.**
- **Delivery.**
  - Forecast: about 8,000 authored lines.
  - Strategy: `ask-on-risk`.
  - **Chain strategy: stacked PRs to main** (owner choice, 2026-10-22).
  - There is no remote yet, so the branches are local until T11.
  - Each work unit is one branch stacked on the previous one, and each is a future PR:

    | # | Branch | Commit | Lines | Notes |
    |---|---|---|---|---|
    | 0 | `main` | `80431b8` base: plan and `.gitignore` | 247 | docs only |
    | 1 | `feat/server-scaffold` | `9dc454e` T01 | 762 + 3,582 lockfile | over 400; one cohesive scaffold, `size:exception` |
    | 2 | `feat/transcription-port` | `d59007e` T02 port | 577 | over 400; types, errors and helpers only make sense together |
    | 3 | `feat/transcription-assemblyai` | `d53a98c` T02 | 442 | about 400 with fixtures |
    | 4 | `feat/transcription-speechmatics` | `3bebec5` T02 | 821 | over 400; 151 lines are fixtures, rest is one adapter |
    | 5 | `feat/transcription-groq` | `f38a258` T02 | 254 | plus `81ec9f4` doc update |
    | 6 | `feat/data-model` | `3ddbdc5` T03 | 286 + ~1,100 generated snapshots | plus `a0f5b7f` doc update |
    | 7 | `feat/ingestion-store` | `566fe88` T04 storage | 537 | over 400; schema change, storage and ingestion only work together |
    | 8 | `feat/derivation-jobs` | `344ed7c` T04 jobs | 674 | over 400; half is tests |
    | 9 | `feat/entries-http` | `3d58234` T04 HTTP, plus the body-limit fix | 484 + fix | |
    | 10 | `feat/embeddings` | `9bf11b0` T05 embedder and jobs | 852 | over 400; adapter, queue and enqueue points belong together |
    | 11 | `feat/hybrid-search` | `8f42dc5` T05 search, plus `77c2610` fix | 708 + 510 | over 400; search with its calibration fix; plus `8fdb320` doc |
    | 12 | `feat/test-db` | `e6eea78` isolated test database | 134 | |
    | 13 | `feat/memory-service` | `19bdffb` T06 memory, dedup, undo | 912 | over 400; one service with its tests |
    | 14 | `feat/agent-loop` | `c4f0753` T06 agent loop | 1,486 | over 400; the loop, tools and prompt log only work together; `size:exception` |
    | 15 | `feat/chat-sse` | `fb07055` T06 SSE, plus `1ecdea8` verifier fix | 521 + 1,178 | over 400; the fix touches all three T06 units; plus `dbd1437` doc |
    | 16 | `feat/consolidation` | `f7de017` T08, plus `63a522f` verifier fix | 2,056 + 834 | over 400; the scheduler and admin trigger register both jobs, so no cohesive split was found; `size:exception`; plus `da9e8d8` doc |
    | 17 | `feat/memory-corrections` | `7044151` T10 server: undoable manual edits | 659 | over 400; service with its tests |
    | 18 | `feat/memory-api` | `cc21a73` T10 server: `/v1/me` | 931 | over 400; router with its tests |
    | 19 | `feat/app-scaffold` | `0c0f1ab` T10 app scaffold, settings, i18n, API client | 1,967 (excl. lockfile) | over 400; scaffold |
    | 20 | `feat/app-chat` | `93c9ab1` T10 chat screen | 1,242 | over 400; one screen with its components and tests |
    | 21 | `feat/chat-citations` | `a1214c8` T10 server: citations in history | 81 | |
    | 22 | `feat/app-attachments` | `0cfb1b8` T10 photo, voice, share target | 1,632 | over 400 |
    | 23 | `feat/app-about-you` | `1fa15be` T10 "What I know about you" | 1,663 | over 400 |

  - The next task branches from the top of the stack.

## Tasks

Route legend:

- **delegated**: one bounded writer, because the task touches two or more non-trivial files.
- **inline**: the parent does it.

The parent passes the task, this document and the verification commands to every writer.

### Stage 1: chat that knows you

- [x] T01 Server scaffold. Delegated. Commit `9dc454e`.
- [x] T02 Transcription port and adapters for AssemblyAI, Speechmatics and Groq. Delegated. Commits `d59007e`, `d53a98c`, `3bebec5`, `f38a258`.
- [x] T03 Data model and migrations. Delegated. Commit `3ddbdc5`.
  - Entries (the raw log) and attachments.
  - Topics, memories (with validity and `supersedes`) and rules.
  - Change log and chat messages.
  - Extensions: pgvector and `pg_trgm`, plus Spanish FTS indexes.
- [x] T04 Ingestion API. Delegated. Commits `566fe88`, `344ed7c`, `3d58234`, plus the body-limit fix.
  - Post text, photo or voice.
  - Durable storage, with an acknowledgement only after the write.
  - Voice is transcribed with Groq; photos get OCR.
- [x] T05 Embeddings with Voyage, and hybrid search (FTS, vector and trigram, combined with RRF) with a relevance threshold. Delegated. Commits `9bf11b0`, `8f42dc5`, `77c2610`.
- [x] T06 Agent turn. Delegated. Commits `e6eea78`, `19bdffb`, `c4f0753`, `fb07055`, `1ecdea8`.
  - Pre-search hints.
  - Haiku 5.5 with tools: open topic, search, remember with dedup, update rule, undo.
  - SSE chat API with citations to source entries.
- [ ] T07 Image experiment. Inline plus delegated.
  - Run local OCR and Haiku vision on the owner's real screenshots.
  - Decide whether OCR alone is enough, and when to fall back to vision.
- [x] T08 Nightly consolidation and daily rollup job. Delegated. Commits `f7de017`, `63a522f`.
- [ ] T09 Deploy to Coolify, with backups and secrets. Needs owner authorization (T11 row above).
- [ ] T10 Expo app. Delegated. The code is done (commits `7044151`, `cc21a73`, `0c0f1ab`, `93c9ab1`, `a1214c8`, `0cfb1b8`, `1fa15be`). Still open: the EAS APK build (needs the owner's Expo account) and an on-device check.
  - Scaffold and EAS APK.
  - One-time token setup.
  - Chat screen: text, photo and voice, with streaming, Undo and citations.
  - Share target.
  - "What I know about you" screen.

### Stage 2: Google Calendar

- [ ] T11 GitHub repo, push and deploy. Owner authorization is required.
- [ ] T12 Google OAuth on the server. Delegated.
  - Calendar read and write tools.
  - Rule-based formats.
  - The owner's events go to the primary calendar; other people's events go to "Bitacora · others".
  - It only touches events it created, tagged through extended properties, unless asked.
  - Sync back of the owner's edits.

### Stage 3: proactive

- [ ] T13 "Routine" rules and a periodic check-in. Delegated.
  - The morning brief is one push, sent only when there is content.
  - Proactive messages are capped at 2–3 a day.
  - Every action is logged with Undo.
- [ ] T14 Push through FCM and Expo, with replies from the notification. Delegated.
- [ ] T15 Widgets: quick note and today. Delegated.

### Stage 4: recorded conversations

- [ ] T16 Bake-off CLI and report. Delegated.
- [ ] T17 GATE: real recordings, then choose AssemblyAI or Speechmatics. Inline.
- [ ] T18 Kotlin recorder module and record widget. Delegated.
  - Microphone foreground service and chunked `.m4a`.
  - Durable upload queue.
- [ ] T19 Speaker identification: voiceprints and the "who were you with?" question. Delegated.
- [ ] T20 Conversation pipeline into memory and calendar. Delegated.

## Acceptance criteria (stage 1 and 2)

1. **Sharing.** A screenshot shared from any app reaches the chat, and its text becomes searchable.
2. **Exam example.** Only exams of the owner's program are scheduled, in the owner's format. The ignored ones are reported, and there is Undo.
3. **Correction.** "That photo was from Análisis" fixes the events and updates memory.
4. **Context.** Nothing about the owner enters a prompt unless it is related, which is visible in the logged prompts.
5. **Calendar.** The owner's edits in Google Calendar are reflected. The app never modifies events it did not create unless asked.
6. **Server checks.** `npm run typecheck`, `npm run lint` and `npm test` pass in `server/`.

## Progress

- **2026-10-22.** The plan was approved (rev 1). T01 and T02 were implemented.
- **T01.**
  - Versions: hono 4.13.13, drizzle-orm 0.45.4, pg 8.23.1, zod 4.6.7, typescript 7.0.2, vitest 5.0.5, biome 2.6.2.
  - Dev DB: `bitacora-dev-db` on :55432.
  - Assessment: high, because it touches auth.
  - An independent verifier passed it. One scoped correction added a DB timeout, bounded shutdown, auth edge tests and a case-insensitive Bearer check.
  - Final results: tests 23/23, typecheck/lint/build 0.
- **T02.**
  - 28 files in `server/src/transcription/`.
  - Tests 65/65 in total. Assessment: medium.
  - Gaps:
    - there is no `baseUrl` override;
    - the Groq prompt is capped at 224 tokens;
    - Groq has no `aac`, so recordings use `.m4a`.
- **Commits (2026-10-22).** Stacked PRs to main chosen. T01 and T02 committed as five stacked branches. Each branch passes typecheck, lint and tests on its own (23, 41, 46, 61 and 65 tests).
- **T03.**
  - Eight tables: `entries`, `attachments`, `topics`, `memories`, `rules`, `change_log`, `chat_messages`, `daily_rollups`.
  - UUID keys; `vector(1024)` embeddings with HNSW cosine on entries, memories and topics; generated `spanish` tsvector with GIN; `gin_trgm_ops` on text.
  - FK rules: attachments cascade with their entry; memories `restrict` the entry they cite, so the raw log cannot lose cited rows; topic and supersede links set null.
  - `entries.text_body` holds the OCR text or transcript; `attachments.derived_text_status` tracks the async step.
  - Spanish stemming does not unify "examen"/"exámenes"; trigram search covers that.
  - Assessment: medium. RDD off, so writer self-check plus parent spot check: migrate OK, tests 75/75, typecheck/lint/build 0.
  - Open: `rules.key` is unique across topics. Revisit in T06 if a rule needs per-topic variants. HNSW is not exercised until T05.
- **T04.**
  - `POST /v1/entries` takes JSON text or multipart (`file` plus an optional `caption`, or `text`). `GET /v1/entries/:id` returns the entry and its derived-text status.
  - The file is written with fsync first. The entry row, the attachment row and the pg-boss job then commit in one transaction (`fromDrizzle`). The 201 is sent after that. On a DB failure the file is removed.
  - New column `entries.derived_text`, written once (`WHERE derived_text IS NULL`). `text_body` is only what the owner typed. The tsvector covers both.
  - Queues `voice-transcription` and `photo-ocr`: 3 retries, 30 s with backoff. The status becomes `failed` only on the last attempt.
  - OCR is a placeholder until T07. Photos end in status `not_available`.
  - Limits: photos 15 MiB, audio 25 MiB, whole body 26 MiB (checked while streaming). Files are named by UUID.
  - Assessment: high (`hot_path`). RDD off, so an independent verifier ran. Verdict: pass with notes. One scoped correction: a `bodyLimit` middleware before `parseBody`, which used to buffer bodies of any size.
  - Accepted note: the client's Content-Type is trusted without sniffing. This is low risk for a single user.
  - Real smoke run with the Groq key: a Spanish voice note was transcribed correctly ("El examen de análisis es el martes 12 de noviembre."). The sha256 matched.
  - Results: tests 115/115, typecheck/lint/build 0. Each slice also passes alone (93, 102, 114).
  - Keys: `~/.credentials/bitacora.env` exists (mode 600). The owner pasted the keys in chat, so rotating them is recommended.
- **T05.**
  - `Embedder` port with a Voyage adapter (`voyage-3.5`, 1024 dims, batches of 100). An `embed` pg-boss queue covers entries, memories and topics. Entries and memories are embedded once; topics are re-embedded on change.
  - `hybridSearch` and `findHints` over memories, topics and entries. RRF with k=60. Superseded memories are excluded.
  - Thresholds, calibrated on real data on 2026-10-22:
    - **Vector:** cosine ≥ 0.50. With real `voyage-3.5`, related pairs scored 0.52–0.64 and unrelated pairs at most 0.44. The first guess of 0.75 rejected every related pair. "qué carrera hago" finds "Estudia Ingeniería en Sistemas" at 0.53 with no shared words.
    - **FTS:** the whole message becomes an OR of Spanish lexemes. A hint needs at least min(2, n) matched lexemes.
    - **Trigram:** per word (4+ chars), with `unaccent`, `word_similarity` ≥ 0.5. A hint needs at least min(2, n) matched words. "analsis" vs "Análisis" scores 0.545.
    - Rationale: a single shared common word ("mañana") must not pull a memory into the prompt (acceptance criterion 4). Single-concept questions are the vector ranker's job.
  - Real smoke run with Voyage found two defects; both were fixed in `77c2610`. Websearch AND semantics never matched a whole sentence, and whole-string trigrams never matched.
  - **Voyage limit:** the account has no payment method, so it is capped at 3 requests/min and 10K tokens/min. The free 200M tokens still apply after adding one. The pre-search degrades to lexical-only on a 429; the embed jobs retry.
  - Assessment: medium. Writer self-check plus parent spot check: tests 150/150, typecheck/lint/build 0.
  - Open: a photo without OCR text or caption never gets an embedding (revisit in T07). Embed failures have no app-visible status.
- **T06.**
  - **Memory service.** `rememberFact` finds similar live memories, then a Haiku judge with a structured tool decides ADD, UPDATE (supersede) or NOOP. An UPDATE that names a memory not offered as a candidate is downgraded to ADD. `updateRule`. Every mutation is written to `change_log`, grouped by turn id. `undoTurn` and `undoLast` are idempotent. Topics are created on demand and are not undone.
  - **Agent loop.** `claude-haiku-5-5`, adaptive thinking, effort `low` (`AGENT_EFFORT`), `tool_choice` auto, at most 8 iterations. Tools: `open_topic` (50 most recent), `search`, `remember`, `update_rule`, `undo`.
  - **Prompt.** The system prompt is static English with a cache breakpoint. The volatile block holds topic names, threshold-passing hints and the Buenos Aires date. It is sent but not persisted.
  - **Citations.** Hints and tool results get `#n` refs. `[#n]` in the answer maps to entry ids.
  - **Limits.** The token budget is 90K, checked before every call. Over budget, the next call goes without tools. History is trimmed by whole exchanges. Tool results are capped at 4,000 chars and 1,500 per hit.
  - **Prompt log.** `agent_runs` stores each call's request JSON, usage, cost and latency, so criterion 4 can be audited.
  - **SSE API.** `POST /v1/chat` (text, `entryId` or multipart) streams `text`, `tool`, `citations`, `done` and `error`. Errors are generic over SSE. Turns are serialized with an in-process mutex. Also `POST /v1/chat/undo` and `GET /v1/chat/history`.
  - **Tests** run on an isolated `bitacora_test` database with file parallelism off. They used to pollute the dev DB and one was flaky. Tests 197/197 on three runs; lint has 0 warnings.
  - Assessment: high (`hot_path`, `process_boundary`). The independent verifier first failed it with 2 blockers (orphan `tool_result` after trimming; thinking blocks dropped on replay), 2 majors (no budget check inside the loop; unvalidated supersede target) and 2 minors (raw error over SSE; concurrent turns). One scoped correction, `1ecdea8`. Re-verification: pass with notes.
  - The parent closed both notes against the live API on 2026-10-22. `tools: []` with `tool_choice` auto after a `tool_use` history is accepted, and a real thinking block replayed in a later turn is accepted.
  - Real smoke run: "Estudio Ingeniería en Sistemas en la UTN" called `remember` and got a voseo answer. A turn of two calls used about 700 input tokens, with 1,370 read from cache.
- **T08.**
  - **Schedule.** pg-boss runs the rollup at 03:30 and the consolidation at 04:00, America/Argentina/Buenos_Aires. The helper uses a fixed UTC-3, since there is no DST since 2009. `schedule()` is an upsert, so restarts do not duplicate it.
  - **Daily rollup.** It covers the previous day's entries and chat text, and writes a diary entry in Rioplatense Spanish to `daily_rollups` (upsert, with `source_entry_ids`). Days with no content get no model call. Input is capped at 15K tokens.
  - **Consolidation.**
    - Duplicate pairs: cosine ≥ 0.85 or trigram ≥ 0.90, at most 50 per run, and nothing changed in the last 30 minutes.
    - The judge returns `merge`, `keep_both` or one-supersedes-the-other. It sees no ids, and a failure falls back to `keep_both`.
    - All changes are written to `change_log` under the run id, so `undoTurn(runId)` reverts them.
    - Topic summaries are regenerated only when the topic's memories changed. Input is capped at 4K tokens.
  - **Admin.** `POST /v1/admin/jobs/{daily-rollup|nightly-consolidation}/run`, with an optional `date`. Returns 409 if a run is already going.
  - Assessment: high (`hot_path`). The verifier passed it with notes: one major (concurrent runs could merge twice) and two minors. One scoped correction, `63a522f`: advisory locks per job on a dedicated connection, `FOR UPDATE` on pairs, a capped summarizer input, and `stop_reason` `error`/`refusal` in `agent_runs`.
  - Real smoke run: three synthetic entries produced a correct diary with its pending items. Cost was USD 0.0001–0.0002 per rollup, and a re-run updates the row (no duplicate).
  - Results: tests 219/219, lint 0 warnings.
- **T10 (code).**
  - **Server.** `/v1/me` covers topics, memories, rules and changes. Corrections supersede the old memory; delete invalidates it; move and rename are logged updates. Every edit returns a `groupId` that can be undone. `change_log.source` is one of `chat_turn`, `consolidation` or `manual_edit`. Citations are now persisted with assistant messages.
  - **App.** `app/`: Expo SDK 58, expo-router, Android only, Biome, jest-expo. The structure follows atomic design with container hooks and presentational components.
    - Onboarding takes the server URL and token, validates them with `/health` and `/v1/me`, and stores them in secure-store.
    - UI language: English by default, Spanish in settings.
    - Chat streams SSE over `expo/fetch`, with citation chips (live and from history) and Undo.
    - Photo (camera or gallery) and voice (`.m4a`, `expo-audio`) are sent as multipart.
    - Share target through `expo-share-intent`: the shared content is staged in the composer and is not sent automatically.
    - "What I know about you" has Topics (inline edit, move, delete, rename), Rules (JSON editor) and Changes (Undo per group).
  - **Pitfall found with `expo prebuild`.** Setting `microphonePermission: false` in `expo-image-picker` removes `RECORD_AUDIO` for the whole app and breaks voice recording. It is left at its default.
  - **arm64.** The Hermes compiler that Expo ships is x86-64, so `expo export` with bytecode fails on the Pi. `--no-bytecode` proves the bundle builds (about 1,200 modules). EAS cloud builders are not affected.
  - Checks: app tsc 0, biome 0, jest 90/90, expo-doctor 20/20, `expo export --no-bytecode` OK, prebuild plugins resolve. Server 247/247.
  - Assessments: medium. Writer self-check plus parent spot checks; each unit was verified on its own.
  - Not verified on a device: the camera and gallery picker, real recording, and the share flow.
- **Pivot (rev 4).** The plan changed:
  - It moved to the chat-and-memory focus.
  - The Telegram option was rejected.
  - Context became dynamic.
  - Vectors moved back into stage 1.
  - Image OCR comes first.
  - The old transcription bake-off moved to stage 4.

## Next step

1. Owner-gated. Everything left in stage 1 needs the owner:
   - **T07** needs real screenshots in `samples/` (gitignored).
   - **T10** needs an Expo account to build the APK, then a device test.
   - **T09/T11** need authorization to create the GitHub repo, push and deploy to Coolify.
   - Stage 2 (T12) needs a Google Cloud OAuth project.
2. The owner adds a payment method in Voyage to lift the 3 RPM limit (free tokens still apply).
3. The owner rotates the three API keys when convenient, because they were pasted in chat.
