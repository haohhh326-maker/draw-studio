import fs from "node:fs/promises";
import path from "node:path";
import { zipSync } from "fflate";
import type { Plugin } from "vite";

const assetName = "autodl-browser-bridge.zip";
const extensionFiles = ["manifest.json", "worker.js", "autodl-page.js", "popup.html", "popup.js"];

export function autoDLExtensionAsset(root: string): Plugin {
  async function archive() {
    const directory = path.join(root, "browser-extensions", "autodl");
    const files = await Promise.all(extensionFiles.map(async name => [
      "draw-studio-autodl/" + name,
      await fs.readFile(path.join(directory, name)),
    ] as const));
    return zipSync(Object.fromEntries(files));
  }
  return {
    name: "canvas-autodl-extension-asset",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.method !== "GET" || request.url !== "/" + assetName) { next(); return; }
        void archive().then(bytes => {
          response.writeHead(200, { "Content-Type": "application/zip", "Content-Disposition": 'attachment; filename="' + assetName + '"' });
          response.end(bytes);
        }, next);
      });
    },
    async generateBundle() {
      this.emitFile({ type: "asset", fileName: assetName, source: await archive() });
    },
  };
}
