import React from "react";
import ReactDOM from "react-dom/client";
import App from "./app/App";
import { AppErrorBoundary } from "./app/AppErrorBoundary";
import { DesktopFrame } from "./app/DesktopFrame";
import "@xyflow/react/dist/style.css";
import "./app/style.css";
const customTitleBar = window.drawStudioHost?.customTitleBar === true;
document.documentElement.classList.toggle("desktop-titlebar-enabled", customTitleBar);
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <DesktopFrame customTitleBar={customTitleBar}><AppErrorBoundary><App /></AppErrorBoundary></DesktopFrame>
  </React.StrictMode>,
);
