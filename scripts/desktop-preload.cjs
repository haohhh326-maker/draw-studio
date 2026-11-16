const { contextBridge, ipcRenderer } = require("electron");

// Only the local canvas renderer receives this bridge. The Muse and DeepSeek
// views have no preload or Node access.
contextBridge.exposeInMainWorld("drawStudioHost", {
  customTitleBar: true,
  invoke(command, args) {
    return ipcRenderer.invoke("draw-studio:service-webview", command, args);
  },
});
