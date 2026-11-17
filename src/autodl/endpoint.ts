import { computeEndpoint } from "../compute/providers";

export function sameAutoDLEndpoint(left: string, right: string): boolean {
  try { return computeEndpoint(new URL(left.trim()).href) === computeEndpoint(new URL(right.trim()).href); }
  catch { return false; }
}
