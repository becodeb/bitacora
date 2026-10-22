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
| Now | `~/.credentials/bitacora.env` with `ANTHROPIC_API_KEY`, `GROQ_API_KEY` and `VOYAGE_API_KEY`. The owner creates it; keys never go in chat. |
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
  - **The chain strategy is not answered yet. Ask it before the first commit**, with these options:
    1. stacked PRs to main (recommended);
    2. feature-branch chain;
    3. a single PR with `size:exception`.
  - No commits exist yet. T01 and T02 are verified but uncommitted.
  - Commit order: T01, then T02 as four work units (port and helpers, AssemblyAI, Speechmatics, Groq).

## Tasks

Route legend:

- **delegated**: one bounded writer, because the task touches two or more non-trivial files.
- **inline**: the parent does it.

The parent passes the task, this document and the verification commands to every writer.

### Stage 1: chat that knows you

- [x] T01 Server scaffold. Delegated. Done and verified; the commit is pending.
- [x] T02 Transcription port and adapters for AssemblyAI, Speechmatics and Groq. Delegated. Done and verified; the commit is pending.
- [ ] T03 Data model and migrations. Delegated.
  - Entries (the raw log) and attachments.
  - Topics, memories (with validity and `supersedes`) and rules.
  - Change log and chat messages.
  - Extensions: pgvector and `pg_trgm`, plus Spanish FTS indexes.
- [ ] T04 Ingestion API. Delegated.
  - Post text, photo or voice.
  - Durable storage, with an acknowledgement only after the write.
  - Voice is transcribed with Groq; photos get OCR.
- [ ] T05 Embeddings with Voyage, and hybrid search (FTS, vector and trigram, combined with RRF) with a relevance threshold. Delegated.
- [ ] T06 Agent turn. Delegated.
  - Pre-search hints.
  - Haiku 5.5 with tools: open topic, search, remember with dedup, update rule, undo.
  - SSE chat API with citations to source entries.
- [ ] T07 Image experiment. Inline plus delegated.
  - Run local OCR and Haiku vision on the owner's real screenshots.
  - Decide whether OCR alone is enough, and when to fall back to vision.
- [ ] T08 Nightly consolidation and daily rollup job. Delegated.
- [ ] T09 Deploy to Coolify, with backups and secrets. Needs owner authorization (T11 row above).
- [ ] T10 Expo app. Delegated.
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
- **Pivot (rev 4).** The plan changed:
  - It moved to the chat-and-memory focus.
  - The Telegram option was rejected.
  - Context became dynamic.
  - Vectors moved back into stage 1.
  - Image OCR comes first.
  - The old transcription bake-off moved to stage 4.

## Next step

1. Ask the chain strategy, then commit T01 and T02.
2. Start T03.
3. The owner adds the keys file for T04–T06.
