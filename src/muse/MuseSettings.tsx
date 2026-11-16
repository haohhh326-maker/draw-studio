import { useEffect } from "react";
import { RefreshCw } from "lucide-react";
import { useMuseSession, refreshMuseSession } from "./session";
import { useStore } from "../stores/store";

export function MuseSettings() {
  const { session, checking } = useMuseSession();
  useEffect(() => {
    void refreshMuseSession();
    const interval = setInterval(() => { void refreshMuseSession(); }, 4000);
    return () => clearInterval(interval);
  }, []);
  const labels = { disconnected: "未连接", checking: "正在同步", "login-required": "等待登录", "waiting-list": "账号暂未开放", connected: "已连接" };
  return <div className="compute-settings-fields muse-settings">
    <strong>Muse 网页账号 · {labels[session.status]}</strong>
    <p>使用你登录的 Muse 账号生成图片或视频。可连接图片、视频和音频作为参考，生成结果自动回到画布。</p>
    <p role="status">{session.message}</p>
    <div className="row">
      <button type="button" className="primary" disabled={checking} onClick={() => void refreshMuseSession()}><RefreshCw size={16} />检查已有会话</button>
      <button type="button" disabled={checking || session.status === "disconnected"} onClick={() => void refreshMuseSession("disconnect")}>断开</button>
    </div>
    <small>已登录的 Muse 会话保存在本机，生成任务在后台运行。需要登录时，点击画布顶部的显示器图标，再选择 Muse，在画布窗口中操作原聊天页面。生成能力和额度以账号实际权限为准。</small>
    <button type="button" onClick={() => { useStore.getState().setComputeProvider("muse"); useStore.setState({ modal: null }); }}>使用 Muse 生成</button>
  </div>;
}
