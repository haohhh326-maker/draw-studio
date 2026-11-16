import { useState } from "react";
import { FolderOpen } from "lucide-react";
import type { WorkflowDefinition } from "../types";
import { runningHubWorkflowCover, runningHubWorkflowCoverMediaType } from "./workflow-metadata";

export function RunningHubWorkflowCover({ workflow }: { workflow: WorkflowDefinition }) {
  const [failed, setFailed] = useState("");
  const url = runningHubWorkflowCover(workflow);
  const video = runningHubWorkflowCoverMediaType(workflow) === "video";
  return <div className="rh-workflow-cover">
    {url && failed !== url ? video
      ? <video key={url} src={url} muted playsInline preload="metadata" aria-label={workflow.name + "封面"}
          onLoadedMetadata={event => { const media = event.currentTarget; if (Number.isFinite(media.duration) && media.duration > 0) media.currentTime = Math.min(.1, media.duration / 2); }}
          onError={() => setFailed(url)} />
      : <img key={url} src={url} alt={workflow.name + "封面"} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(url)} />
      : <><FolderOpen size={28} aria-hidden="true" /><span>{url ? "封面暂不可用" : "暂无封面"}</span></>}
  </div>;
}
