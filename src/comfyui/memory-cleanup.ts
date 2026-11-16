import type { Connection } from "../types";
import { ApiError, ComfyUIClient } from "./client";

type CleanupEnvironment = {
  connection: () => Connection;
  subscribe: (listener: () => void) => () => void;
  notify: (message: string) => void;
  busy: (value: boolean) => void;
};
const identity = (connection: Connection) => JSON.stringify([connection.baseUrl, connection.token, connection.authHeader, connection.authPrefix]);

/** A single in-flight cleanup, cancelled before submission when its connection changes. */
export class MemoryCleanupAction {
  private pending?: AbortController;
  private unsubscribe?: () => void;
  private disposed = false;
  constructor(private readonly environment: CleanupEnvironment) {}

  async run(): Promise<void> {
    if (this.disposed || this.pending) return;
    const connection = { ...this.environment.connection() };
    if (!connection.baseUrl.trim()) { this.environment.notify("请先填写 ComfyUI 服务地址。"); return; }
    const expected = identity(connection), controller = new AbortController();
    this.pending = controller;
    this.environment.busy(true);
    this.unsubscribe = this.environment.subscribe(() => {
      if (identity(this.environment.connection()) !== expected) controller.abort();
    });
    try {
      await new ComfyUIClient(connection).freeMemory(controller.signal);
      if (!this.disposed) {
        if (controller.signal.aborted || identity(this.environment.connection()) !== expected)
          this.environment.notify("连接已切换，上一连接的清理结果未确认。");
        else this.environment.notify("已向工作站请求卸载模型并清理内存 / 显存。");
      }
    } catch (reason) {
      if (this.disposed) return;
      if (controller.signal.aborted || identity(this.environment.connection()) !== expected)
        this.environment.notify("连接已切换，上一连接的清理结果未确认。");
      else if (reason instanceof ApiError)
        this.environment.notify(`清理请求失败（HTTP ${reason.status}），请稍后重试。`);
      else if (reason instanceof Error && /fetch|network/i.test(reason.message))
        this.environment.notify("无法连接工作站，清理请求未确认。");
      else this.environment.notify(reason instanceof Error ? reason.message : "清理请求失败，请稍后重试。");
    } finally {
      this.unsubscribe?.(); this.unsubscribe = undefined;
      this.pending = undefined;
      if (!this.disposed) this.environment.busy(false);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.pending?.abort();
    this.unsubscribe?.(); this.unsubscribe = undefined;
  }
}
