import { create } from "zustand";
import type { OptimizationTarget } from "./types";

/** View state only; no connection credentials or project content is persisted here. */
export const useOptimizationPanel = create<{
  open: boolean; target: OptimizationTarget | null; returnFocus: HTMLButtonElement | null;
  canvasId?: string; nodeId?: string; promptField?: "generation" | "text";
}>(() => ({ open: false, target: null, returnFocus: null }));
