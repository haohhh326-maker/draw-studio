import { useRef, useState } from "react";
import {
  ArrowUpRight,
  FolderOpen,
  Plus,
  Trash2,
  ChevronRight,
} from "lucide-react";
import { useStore } from "../stores/store";
import { StorageLocation } from "./StorageLocation";
import { Modal } from "../components/ui";
import { HomeCarousel } from "./HomeCarousel";
import { homeBanners } from "./home-banners";
import { ProjectCover } from "./ProjectCover";
import "./project-home.css";

export function ProjectHome({
  onImport,
}: {
  onImport: (file?: File) => Promise<void>;
}) {
  const projects = useStore((s) => s.projects);
  const navigating = useStore((s) => s.navigating);
  const toast = useStore((s) => s.toast);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [storageId, setStorageId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const items = Object.values(projects)
    .filter((item): item is typeof item & { project: NonNullable<typeof item.project> } => !!item.project && !item.deletedAt)
    .sort((a, b) => b.project.updatedAt - a.project.updatedAt);
  const visibleItems = showAll ? items : items.slice(0, 4);
  const startCreating = () => { setName(""); setCreating(true); };
  const run = async (action: () => Promise<void>) => {
    try {
      await action();
    } catch (e) {
      useStore.getState().notify(String(e));
    }
  };
  return (
    <main className="project-home project-home-showcase">
      <section className="project-home-content">
        <HomeCarousel slides={homeBanners} />
        <div className="project-home-heading">
          <div>
            <h1>{showAll ? "全部项目" : "最近项目"}</h1>
          </div>
          <div className="project-home-actions">
            <button
              disabled={navigating}
              onClick={() => fileRef.current?.click()}
            >
              <FolderOpen size={17} />
              导入项目
            </button>
            <button
              className="project-home-view-all"
              disabled={navigating}
              onClick={() => setShowAll(!showAll)}
            >
              {showAll ? "收起项目" : "查看全部"}<ChevronRight size={17} />
            </button>
          </div>
        </div>
        <div className="project-grid">
            <button className="project-new-card" aria-label="新建项目" disabled={navigating} onClick={startCreating}>
              <span className="project-new-icon"><Plus size={35} strokeWidth={1.8} /></span>
              <strong>新建项目</strong>
              <span>填写项目名称，<br />创建完成即可直接进入画布。</span>
            </button>
            {visibleItems.map(({ project }) => (
              <article className="project-card-shell" key={project.id}>
                <button
                  className="project-card"
                  key={project.id}
                  disabled={navigating}
                  aria-label={"打开项目：" + project.name}
                  onClick={() =>
                    void run(() => useStore.getState().openProject(project.id))
                  }
                >
                  <div className="project-card-cover"><ProjectCover project={project} /></div>
                  <div className="project-card-info">
                    <h2>{project.name || "未命名项目"}</h2>
                  </div>
                </button>
                <div className="project-card-operations">
                  <button disabled={navigating} onClick={() => setStorageId(project.id)}><FolderOpen size={14} />存放路径</button>
                  <button className="danger" aria-label={"删除项目：" + project.name} disabled={navigating} onClick={() => setDeleting(project.id)}><Trash2 size={14} />删除</button>
                </div>
              </article>
            ))}
          </div>
      </section>
      <input
        ref={fileRef}
        type="file"
        hidden
        accept=".aicanvas,.zip"
        onChange={(e) => {
          void onImport(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      {storageId && (
        <StorageLocation
          projectId={storageId}
          onClose={() => setStorageId(null)}
        />
      )}
      {deleting && (
        <Modal
          title="删除项目"
          onClose={() => {
            if (!navigating) setDeleting(null);
          }}
        >
          <div className="storage-dialog">
            <p>
              永久删除“{projects[deleting]?.project?.name}”？删除后无法在画布中恢复；已存到其他文件夹的项目文件不会删除。
            </p>
            <div className="storage-buttons">
              <button disabled={navigating} onClick={() => setDeleting(null)}>
                取消
              </button>
              <button
                className="danger"
                disabled={navigating}
                onClick={() =>
                  void run(async () => {
                    await useStore.getState().deleteProject(deleting);
                    setDeleting(null);
                  })
                }
              >
                永久删除
              </button>
            </div>
          </div>
        </Modal>
      )}
      {creating && (
        <Modal
          title="新建项目"
          onClose={() => {
            if (!navigating) setCreating(false);
          }}
        >
          <form
            className="new-project-form"
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => useStore.getState().newProject(name));
            }}
          >
            <label htmlFor="new-project-name">项目名称</label>
            <input
              id="new-project-name"
              autoFocus
              maxLength={100}
              placeholder="未命名项目"
              value={name}
              disabled={navigating}
              onChange={(e) => setName(e.target.value)}
            />
            <p>项目和素材会自动保存在本机，退出后可随时继续。</p>
            <button className="primary" type="submit" disabled={navigating}>
              {navigating ? "正在创建…" : "创建并打开"}
              <ArrowUpRight size={16} />
            </button>
          </form>
        </Modal>
      )}
      {navigating && (
        <div className="project-transition" role="status">
          正在打开项目…
        </div>
      )}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </main>
  );
}
