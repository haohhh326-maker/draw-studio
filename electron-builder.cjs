const path = require("node:path");
const fs = require("node:fs/promises");
module.exports = {
  appId: "studio.clearframe.canvas",
  productName: "Draw studio",
  directories: { app: ".desktop-package/app", output: "release", buildResources: "build/desktop" },
  electronVersion: require("./node_modules/electron/package.json").version,
  electronDist: path.join(__dirname, "node_modules", "electron", "dist"),
  asar: true,
  npmRebuild: false,
  files: ["*.cjs", "package.json", "!node_modules/**/*"],
  extraResources: [{ from: ".desktop-package/resources", to: "draw-studio" }],
  afterPack: async context => {
    await fs.cp(path.join(__dirname, ".desktop-package", "resources", "node_modules"),
      path.join(context.appOutDir, "resources", "draw-studio", "node_modules"), { recursive: true });
  },
  win: { target: [{ target: "nsis", arch: ["x64"] }], icon: "build/desktop/icon.ico", signAndEditExecutable: true,
    artifactName: "Draw-studio-${version}-Windows-x64-Setup.${ext}" },
  nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true, createStartMenuShortcut: true, shortcutName: "Draw studio",
    deleteAppDataOnUninstall: false, runAfterFinish: false, installerIcon: "build/desktop/icon.ico",
    uninstallerIcon: "build/desktop/icon.ico", include: path.join(__dirname, "build/desktop/installer.nsh"),
    installerLanguages: ["zh_CN", "en_US"], language: "2052" },
};
