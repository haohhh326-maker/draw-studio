import type { AutoDLInstancesResult } from "../../src/autodl/types";

export type AutoDLWebsiteOperation = "list" | "status" | "preflight" | "power-on" | "power-off";
export type AutoDLWebsiteFailureCode = "NO_AUTODL_TAB" | "CONTRACT_ERROR" | "LOGIN_REQUIRED"
  | "NETWORK_ERROR" | "POWER_UNKNOWN" | "ACCOUNT_PREREQUISITE" | "NO_GPU_CAPACITY"
  | "POWER_STATE_CONFLICT" | "POWER_REJECTED" | "COMMAND_EXPIRED" | "INSTANCE_NOT_FOUND"
  | "INSUFFICIENT_BALANCE" | "INSTANCE_EXPIRED";
export type AutoDLWebsiteResult =
  | { ok: true; value: AutoDLInstancesResult | { status: string } | { accepted: true } }
  | { ok: false; errorCode: AutoDLWebsiteFailureCode; httpStatus?: number; remoteCode?: string; requestId?: string };

export function runAutoDLCommand(operation: AutoDLWebsiteOperation, instanceUuid: string | null, expiresAt: number): Promise<AutoDLWebsiteResult>;
