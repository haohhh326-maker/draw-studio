import { Component, type ReactNode } from "react";
import { useStore } from "../stores/store";

export class AppErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean; reloading: boolean; saveError: string }
> {
  state = { failed: false, reloading: false, saveError: "" };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  reload = async () => {
    if (this.state.reloading) return;
    this.setState({ reloading: true, saveError: "" });
    try {
      const state = useStore.getState();
      if (state.ready && state.projectOpen) await state.save(true);
      window.location.reload();
    } catch {
      this.setState({ reloading: false, saveError: "项目暂未保存成功，请重试。" });
    }
  };

  render() {
    if (!this.state.failed) return this.props.children;
    return <div className="startup app-recovery" role="alert">
      <strong>画布暂时无法显示</strong>
      <p>重新加载以恢复当前界面。</p>
      {this.state.saveError && <p>{this.state.saveError}</p>}
      <button type="button" className="primary" onClick={() => void this.reload()} disabled={this.state.reloading}>
        {this.state.reloading ? "正在重新加载…" : "重新加载"}
      </button>
    </div>;
  }
}
