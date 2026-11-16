import type { NodeData } from "../types";

export type PromptVersion = "original" | "optimized";

export type PromptDrafts = {
  original: string;
  optimized?: string;
  version: PromptVersion;
};

/** Project archives may predate drafts or contain malformed optional metadata. */
export function readPromptDrafts(value: unknown): PromptDrafts | undefined {
  if (!value || typeof value !== "object") return;
  const draft = value as Partial<PromptDrafts>;
  if (typeof draft.original !== "string" || (draft.optimized !== undefined && typeof draft.optimized !== "string") ||
    (draft.version !== "original" && draft.version !== "optimized") || (draft.version === "optimized" && draft.optimized === undefined)) return;
  return draft as PromptDrafts;
}

/** Keep each saved buffer aligned with its editor, in the same project edit.
 * Only undo/redo may infer a version change by matching the other saved buffer. */
export function reconcilePromptDraftData(data: NodeData, fallback?: NodeData["promptDrafts"], restoreVersion = false): NodeData {
  let drafts = data.promptDrafts;
  for (const field of ["generation", "text"] as const) {
    if (field === "generation" && !data.generation) continue;
    const saved = readPromptDrafts(drafts?.[field]) ?? readPromptDrafts(fallback?.[field]);
    if (!saved) continue;
    const prompt = field === "text" ? data.text ?? "" : data.generation!.prompt;
    const otherVersion = saved.version === "original" ? "optimized" : "original";
    const next = saved[saved.version] === prompt ? saved :
      restoreVersion && saved[otherVersion] === prompt ? { ...saved, version: otherVersion } : { ...saved, [saved.version]: prompt };
    if (drafts?.[field] !== next) drafts = { ...drafts, [field]: next };
  }
  return drafts === data.promptDrafts ? data : { ...data, promptDrafts: drafts };
}

type PromptHistoryState = {
  project: { id: string; canvases: readonly unknown[] };
  past: readonly unknown[];
  future: readonly unknown[];
};

/** Only the canvas undo/redo stack transitions qualify, never checkpoints or ordinary edits. */
export function isPromptHistoryRestore(current: PromptHistoryState, previous: PromptHistoryState) {
  if (current.project.id !== previous.project.id || current.project.canvases === previous.project.canvases) return false;
  const undo = current.past.length === previous.past.length - 1 && current.future.length === previous.future.length + 1
    && current.past.every((entry, index) => entry === previous.past[index])
    && previous.future.every((entry, index) => entry === current.future[index + 1]);
  const redo = current.past.length === previous.past.length + 1 && current.future.length === previous.future.length - 1
    && previous.past.every((entry, index) => entry === current.past[index])
    && current.future.every((entry, index) => entry === previous.future[index + 1]);
  return undo || redo;
}

export function promptDraftKey(projectId: string, canvasId: string, nodeId: string, field: string) {
  return JSON.stringify([projectId, canvasId, nodeId, field]);
}

/** Stable UI snapshots mirror the node's saved drafts, independently of selection. */
export function createPromptDraftSessions() {
  const drafts = new Map<string, PromptDrafts>();
  const listeners = new Set<() => void>();
  const put = (key: string, value: PromptDrafts) => {
    drafts.set(key, value);
    for (const listener of listeners) listener();
    return value;
  };
  const capture = (key: string, prompt: string, restoreVersion = false): PromptDrafts => {
    const current = drafts.get(key);
    if (!current) return put(key, { original: prompt, version: "original" });
    const otherVersion = current.version === "original" ? "optimized" : "original";
    // Undo/redo can restore the other saved buffer. This flag is never used for direct text edits.
    if (restoreVersion && current[current.version] !== prompt && current[otherVersion] === prompt)
      return put(key, { ...current, version: otherVersion });
    return current[current.version] === prompt ? current : put(key, { ...current, [current.version]: prompt });
  };
  return {
    get: (key: string) => drafts.get(key),
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    restore(key: string, value: unknown) {
      const saved = readPromptDrafts(value), current = drafts.get(key);
      if (!saved) return current;
      return current?.original === saved.original && current.optimized === saved.optimized && current.version === saved.version
        ? current : put(key, { original: saved.original, ...(saved.optimized === undefined ? {} : { optimized: saved.optimized }), version: saved.version });
    },
    capture,
    /** Identity of the source draft protects edits, including edits that were later changed back. */
    complete(key: string, source: PromptDrafts, prompt: string) {
      if (drafts.get(key) !== source) return undefined;
      return put(key, { ...source, optimized: prompt, version: "optimized" });
    },
    switchVersion(key: string, prompt: string, requested?: PromptVersion) {
      const current = capture(key, prompt);
      if (current.optimized === undefined) return undefined;
      const version = requested ?? (current.version === "original" ? "optimized" : "original");
      return version === current.version ? current : put(key, { ...current, version });
    },
  };
}

export const promptDraftSessions = createPromptDraftSessions();
