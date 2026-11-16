import { useEffect, useState } from "react";
import { Modal } from "../components/ui";
import { useStore } from "../stores/store";
import { exportProject } from "./storage";
import {
  authorizeDirectory,
  canChooseDirectory,
  chooseDirectory,
  clearDirectory,
  readDirectory,
  syncProjectDirectory,
  type ProjectDirectory,
} from "./directory";

export function StorageLocation({
  projectId,
  onClose,
}: {
  projectId: string;
  onClose: () => void;
}) {
  const [directory, setDirectory] = useState<ProjectDirectory | null>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const item = useStore((s) => s.projects[projectId]);
  useEffect(() => {
    void readDirectory(projectId)
      .then((d) => setDirectory(d ?? null))
      .catch((e) => setMessage(String(e)));
  }, [projectId]);
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      await action();
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError"))
        setMessage(String(e));
    } finally {
      setBusy(false);
    }
  };
  if (!item?.project) return null;
  return (
    <Modal
      title="存放路径"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="storage-dialog">
        <strong>{item.project.name}</strong>
        <p>
          项目会自动保存在本机项目库。设置文件夹后，还会在退出项目时保存一份包含画布、任务和素材的项目文件。
        </p>
        <div className="storage-location">
          {directory === undefined
            ? "正在读取…"
            : directory
              ? directory.label +
                (directory.mode === "browser" ? "（已选择的文件夹）" : "")
              : "本机项目库 · 未设置额外存放目录"}
        </div>
        {directory && <p>文件：project-{projectId}.aicanvas</p>}
        {!canChooseDirectory() && (
          <p>
            此浏览器不支持直接选择文件夹。可导出项目选择保存位置，或用 Edge /
            Chrome 打开此网址设置目录。
          </p>
        )}
        <div className="storage-buttons">
          {canChooseDirectory() && (
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const next = await chooseDirectory(projectId);
                  if (!next) return;
                  setDirectory(next);
                  await syncProjectDirectory(item.project, item.workflows);
                  setMessage("已保存到所选文件夹，退出项目时会同步更新。");
                })
              }
            >
              选择文件夹
            </button>
          )}
          {directory && (
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await authorizeDirectory(directory);
                  await syncProjectDirectory(item.project, item.workflows);
                  setMessage("项目文件已更新。");
                })
              }
            >
              授权并保存
            </button>
          )}
          <button
            disabled={busy}
            onClick={() =>
              void run(() => exportProject(item.project, item.workflows))
            }
          >
            导出项目文件
          </button>
          {directory && (
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await clearDirectory(projectId);
                  setDirectory(null);
                  setMessage("已取消目录同步，已有文件保留。");
                })
              }
            >
              取消目录同步
            </button>
          )}
        </div>
        {message && <p role="status">{message}</p>}
      </div>
    </Modal>
  );
}
