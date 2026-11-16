import type { Page } from "playwright";
import { readMuseTurnSnapshot, type MuseTurnReference, type MuseDeliveryDiagnostic } from "./muse-turn-anchor";

export type MuseDeliveryState = {
  state: "missing" | "ambiguous" | "pending" | "unconfirmed" | "failed" | "accepted";
  message?: string;
  diagnostic?: MuseDeliveryDiagnostic;
};

/** Observe delivery without appending tracking text to the user's message. */
export async function readMuseDeliveryState(page: Page, reference: MuseTurnReference): Promise<MuseDeliveryState> {
  return (await readMuseTurnSnapshot(page, reference)).delivery;
}
