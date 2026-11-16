import type { Connection } from "../types";
import { isRunningHubNativeConnection } from "../runninghub/native-connection";

export type ComfyConnectionMode = "cloud" | "native";
export type ComfyConnectionProfiles = Record<ComfyConnectionMode, Connection>;
export const COMFY_CONNECTION_PROFILES_RECORD = "comfy-connection-profiles";
export const defaultNativeComfyConnection: Connection = {
  name: "RunningHub 原生 ComfyUI", baseUrl: "https://www.runninghub.cn/proxy", token: "",
  authHeader: "Authorization", authPrefix: "Bearer ", timeoutMinutes: 60,
};
export const comfyConnectionMode = (connection: Pick<Connection, "baseUrl">): ComfyConnectionMode =>
  isRunningHubNativeConnection(connection) ? "native" : "cloud";
