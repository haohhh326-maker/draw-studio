export type AutoDLBinding = { instanceUuid: string };

export type AutoDLAccountSession = {
  status: "disconnected" | "login-required" | "connected" | "error";
  message: string;
  accountName?: string;
};

export type AutoDLInstanceSummary = { instanceUuid: string; name: string; status: string };
export type AutoDLInstancesResult = { instances: AutoDLInstanceSummary[] };
export type AutoDLPairCode = { code: string; expiresAt: number };

export type AutoDLPowerSettings = {
  enabled: boolean;
  endpoint: string;
  instanceUuid: string;
  tokenConfigured: boolean;
};

export type AutoDLPowerPhase = "disabled" | "unknown" | "off" | "starting" | "ready" | "stopping" | "error";

export type AutoDLPowerStatus = {
  settings: AutoDLPowerSettings;
  phase: AutoDLPowerPhase;
  activeTasks: number;
  pendingStop: boolean;
  message: string;
  error?: string;
};

export type AutoDLLease = {
  leaseId: string;
  instanceUuid: string;
  phase: "starting" | "ready" | "failed" | "released";
  message?: string;
  error?: string;
};

export type AutoDLAcquireRequest = {
  endpoint: string;
  instanceUuid: string;
  taskId: string;
  attemptId: string;
};

export type AutoDLSettingsInput = {
  enabled: boolean;
  endpoint: string;
  instanceUuid: string;
};
