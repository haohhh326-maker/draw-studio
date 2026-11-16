import { create } from "zustand";
import { getMuseSession, loginMuseSession, disconnectMuseSession, type MuseSession } from "./client";

export const useMuseSession = create<{ session: MuseSession; checking: boolean }>(() => ({
  session: { status: "disconnected", message: "正在检查本机 Muse 会话。" }, checking: false,
}));
export async function refreshMuseSession(action: "check" | "login" | "disconnect" = "check") {
  if (useMuseSession.getState().checking) return;
  useMuseSession.setState({ checking: true });
  try {
    const session = await (action === "login" ? loginMuseSession() : action === "disconnect" ? disconnectMuseSession() : getMuseSession());
    useMuseSession.setState({ session });
  } catch (error) {
    useMuseSession.setState({ session: { status: "disconnected", message: error instanceof Error ? error.message : "Muse 连接失败。" } });
  } finally { useMuseSession.setState({ checking: false }); }
}

