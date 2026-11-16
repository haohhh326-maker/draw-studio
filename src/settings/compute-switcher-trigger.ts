import { useStore } from "../stores/store";

/** The two cloud buttons share one popover and retain the actual opening anchor. */
export const computeSwitcherAnchor = { current: null as HTMLElement | null };
export type ComputeSwitcherTarget = { canvasId: string; nodeId?: string };
export const computeSwitcherTarget = { current: undefined as ComputeSwitcherTarget | undefined };

export function toggleComputeSwitcher(anchor: HTMLElement, target: ComputeSwitcherTarget) {
  const alreadyOpen = useStore.getState().modal === "compute-switcher" && computeSwitcherAnchor.current === anchor;
  computeSwitcherAnchor.current = anchor;
  computeSwitcherTarget.current = target;
  useStore.setState({ modal: alreadyOpen ? null : "compute-switcher" });
}
