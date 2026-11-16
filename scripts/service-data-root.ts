import os from "node:os";
import path from "node:path";

/** The desktop host gives its background services an isolated writable home. */
export function serviceDataRoot() {
  const configured = process.env.DRAW_STUDIO_DATA_HOME?.trim();
  return configured ? path.resolve(configured)
    : path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share"), "DrawStudio");
}
