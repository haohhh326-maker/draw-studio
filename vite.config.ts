import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { realpathSync } from "node:fs";
import { workflowLibraryPlugin } from "./scripts/workflow-library-plugin";
import { promptOptimizationPlugin } from "./scripts/prompt-optimization-plugin";
import { runningHubProxyPlugin } from "./scripts/runninghub-proxy-plugin";
import { runningHubNativeProxyPlugin } from "./scripts/runninghub-native-proxy-plugin";
import { cloudFileTransferPlugin } from "./scripts/cloud-file-transfer-plugin";
import { aifisherWorkflowReaderPlugin } from "./scripts/aifisher-workflow-reader-plugin";
import { videoPlaybackPlugin } from "./scripts/video-playback-plugin";
import { museBridgePlugin } from "./scripts/muse-bridge-plugin";
import { deepSeekBridgePlugin } from "./scripts/deepseek-bridge-plugin";
import { autoDLPowerPlugin } from "./scripts/autodl-power-plugin";
export default defineConfig({
  root: realpathSync(process.cwd()),
  plugins: [react(), museBridgePlugin(realpathSync(process.cwd())), deepSeekBridgePlugin(realpathSync(process.cwd())), autoDLPowerPlugin(realpathSync(process.cwd())), videoPlaybackPlugin(), aifisherWorkflowReaderPlugin(realpathSync(process.cwd())), workflowLibraryPlugin(realpathSync(process.cwd())), promptOptimizationPlugin(realpathSync(process.cwd())), runningHubProxyPlugin(), runningHubNativeProxyPlugin(), cloudFileTransferPlugin(realpathSync(process.cwd()))],
  clearScreen: false,
  server: { strictPort: true },
  // Cached upstream pages and archived examples are not application entries.
  optimizeDeps: { entries: ["index.html"] },
  build: {
    // Open canvases can still request lazy chunks from the previous build.
    emptyOutDir: false,
    target: "es2022",
    rollupOptions: {
      output: {
        manualChunks: {
          canvas: ["@xyflow/react"],
          react: ["react", "react-dom", "zustand"],
        },
      },
    },
  },
});
