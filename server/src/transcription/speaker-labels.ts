/**
 * Maps arbitrary provider speaker labels (AssemblyAI's `"A"`, `"B"`, …,
 * or Speechmatics' `"S1"`, `"S3"`, …) to normalized labels `"S1"`,
 * `"S2"`, … assigned in order of first appearance in `rawLabels`.
 *
 * The same raw label always maps to the same normalized label,
 * including on reappearance. `null`/`undefined` (no diarization for
 * that item) maps straight through to `null`, without being counted as
 * a speaker — so a run like `["A", null, "A", "B"]` normalizes to
 * `["S1", null, "S1", "S2"]`.
 *
 * Speechmatics' own labels already look like ours (`S1`, `S2`), but are
 * not trusted as already being in first-appearance order — they are
 * re-normalized the same way AssemblyAI's `A`/`B` labels are, so both
 * adapters share one normalization rule instead of two similar ones.
 */
export function normalizeSpeakerLabels(
  rawLabels: ReadonlyArray<string | null | undefined>,
): Array<string | null> {
  const normalizedByRaw = new Map<string, string>();

  return rawLabels.map((raw) => {
    if (raw === null || raw === undefined) {
      return null;
    }

    const existing = normalizedByRaw.get(raw);
    if (existing !== undefined) {
      return existing;
    }

    const normalized = `S${normalizedByRaw.size + 1}`;
    normalizedByRaw.set(raw, normalized);
    return normalized;
  });
}
