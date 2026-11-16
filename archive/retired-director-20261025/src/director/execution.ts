import type {
  ApiWorkflow,
  Asset,
  Connection,
  RemoteFile,
  RunningHubInstanceType,
  WorkflowDefinition,
  UploadedInput,
} from "../types";
import { RunningHubClient } from "../runninghub/client";
import { readableRunningHubError } from "../runninghub/error-message";
import { attachRunningHubExecutionContract } from "../runninghub/execution-contract";
import { collectWorkflowOutputs, ExecutionError } from "../comfyui/client";
import { getBlob } from "../projects/storage";
import { importAsset } from "../assets/assets";
import { useStore } from "../stores/store";
import {
  normalizeDirectorWidgetValues,
  type DirectorSnapshot,
} from "./upstream-host";
import workflowTemplate from "./workflow-template.json";
import { attachDirectorOutput } from "./output-helper";
import { directorAssetPath } from "./media-bridge";
import { directorRunSelection, prepareDirectorModeModel } from "./mode-model";
import {
  directorSnapshotProgress,
  recordedDirectorProgress,
  type DirectorRunProgress,
} from "./run-progress";
import {
  directorOutputKey,
  normalizeDirectorOutputKey,
} from "./output-identity";
import { outputKey } from "../comfyui/files";
import {
  createOutputDownloads,
  type OutputDownloads,
} from "../generation/output-downloads";

export const DIRECTOR_WORKFLOW_ID = "2113664133047603202";
/** The default graph is the user's exported API JSON; editing one run never mutates that source. */
export async function readDirectorWorkflow(
  client: Pick<RunningHubClient, "getWorkflow">,
  workflowId: string,
  signal?: AbortSignal,
): Promise<ApiWorkflow> {
  signal?.throwIfAborted();
  if (workflowId === DIRECTOR_WORKFLOW_ID)
    return structuredClone(workflowTemplate) as ApiWorkflow;
  try {
    return await client.getWorkflow(workflowId, signal);
  } catch (reason) {
    if (reason instanceof Error)
      reason.message = readableRunningHubError(reason.message);
    throw reason;
  }
}
export type DirectorReceipt = {
  version: 1;
  workflowId: string;
  site: string;
  instanceType: RunningHubInstanceType;
  clientId: string;
  requestId: string;
  taskId?: string;
  outputs: Pick<WorkflowDefinition["output"], "nodeId" | "field" | "kind">[];
  downloads: { key: string; assetId: string }[];
  timing?: DirectorTiming;
  runProgress?: DirectorRunProgress;
};
export type DirectorTiming = {
  /** Local observation timestamps; RH execution time is reported separately below. */
  startedAt: number;
  submittedAt?: number;
  remoteCompletedAt?: number;
  completedAt?: number;
  providerDurationSeconds?: number;
  uploadMs: number;
  downloadMs: number;
  importMs: number;
  saveMs: number;
};
export type DirectorRun = {
  taskId?: string;
  workflowId: string;
  site: string;
  status: string;
  message: string;
  outputIds?: string[];
  receipt?: DirectorReceipt;
  timing?: DirectorTiming;
  runProgress?: DirectorRunProgress;
  syncPhase?: "download" | "import" | "save";
};
const running = new Map<
  string,
  {
    abort: AbortController;
    client?: RunningHubClient;
    taskId?: string;
    remoteCancelConfirmed: boolean;
    remoteCompleted: boolean;
  }
>();
export const directorSessionId = (canvasId: string, nodeId?: string) =>
  nodeId ? JSON.stringify([canvasId, nodeId]) : canvasId;
export const directorRunning = (canvasId: string, nodeId?: string) =>
  running.has(directorSessionId(canvasId, nodeId));
export const anyDirectorRunning = () => running.size > 0;
const fileKeys = ["imageFile", "videoFile", "audioFile"];
const pathOf = (value: string, folder: unknown) => {
  const path = value.replace(/\\/g, "/"),
    sub = String(folder || "")
      .replace(/\\/g, "/")
      .replace(/^\/+|\/+$/g, "");
  return sub && !path.startsWith(sub + "/") ? sub + "/" + path : path;
};

/** Only referenced files are uploaded; slot order and the original timeline schema are retained. */
export async function uploadDirectorTimeline(
  timeline: Record<string, any>,
  media: Record<string, string>,
  assets: Record<string, Asset>,
  upload: (asset: Asset) => Promise<UploadedInput>,
) {
  const pending = new Map<string, Promise<UploadedInput>>();
  const canonical = new Map(
    Object.values(assets).map((asset) => [directorAssetPath(asset), asset]),
  );
  async function visit(value: any): Promise<any> {
    if (Array.isArray(value)) return Promise.all(value.map(visit));
    if (!value || typeof value !== "object") return value;
    const result: Record<string, any> = { ...value };
    for (const key of fileKeys) {
      if (typeof value[key] !== "string" || !value[key]) continue;
      const path = pathOf(value[key], value.subfolder),
        id = media[path] ?? media[value[key]];
      const asset =
        (id ? assets[id] : undefined) ??
        canonical.get(path) ??
        canonical.get(value[key]);
      if (!asset)
        throw new Error("素材尚未导入本画布，请重新选择：" + value[key]);
      let request = pending.get(asset.id);
      if (!request) {
        request = upload(asset);
        pending.set(asset.id, request);
      }
      const uploaded = await request;
      // The upstream image loader reads imageFile directly and ignores subfolder.
      result[key] = uploaded.inputName;
      result.subfolder = uploaded.subfolder;
      result.type = "input";
      if (Object.hasOwn(result, "fileName")) result.fileName = uploaded.name;
    }
    for (const [key, child] of Object.entries(result))
      if (child && typeof child === "object") result[key] = await visit(child);
    return result;
  }
  return visit(timeline);
}

export function directorDefinition(
  graph: ApiWorkflow,
  snapshot: DirectorSnapshot,
  workflowId: string,
  baseUrl: string,
): WorkflowDefinition {
  const entries = Object.entries(graph).filter(([, node]) =>
    ["MiniMaxH3Director", "ComfyMiniMaxH3Director"].includes(node.class_type),
  );
  if (entries.length !== 1)
    throw new Error("工作流必须包含一个 MiniMax H3 导演台节点。");
  const [nodeId, source] = entries[0];
  if (source.inputs.r2v_groups || source.inputs.i2v_groups)
    throw new Error(
      "此工作流使用外接素材组，会覆盖导演台编辑。请先在官网解除该连接。",
    );
  const values = normalizeDirectorWidgetValues(snapshot.values);
  const { template, loaderNodeId } = prepareDirectorModeModel(
    graph,
    nodeId,
    workflowId,
    values.task_type,
    snapshot.timeline,
  );
  const mutable = Object.entries(values).filter(([key]) =>
    Object.hasOwn(source.inputs, key),
  );
  for (const [key, value] of mutable) template[nodeId].inputs[key] = value;
  template[nodeId].inputs.timeline_data = JSON.stringify(snapshot.timeline);
  delete template[nodeId].inputs.minimax_director_ui;
  const outputIds = Object.entries(template)
    .filter(([, node]) =>
      /^(SaveVideo|VHS_VideoCombine|SaveAnimatedWEBP|SaveAnimatedPNG)$/.test(
        node.class_type,
      ),
    )
    .map(([id]) => id);
  if (!outputIds.length) throw new Error("工作流没有可识别的视频保存节点。");
  const mapping = mutable.map(([field]) => ({
    semantic: field,
    nodeId,
    field,
  }));
  if (!mapping.some((item) => item.field === "timeline_data"))
    mapping.push({ semantic: "timeline_data", nodeId, field: "timeline_data" });
  mapping.push({
    semantic: "director_unet",
    nodeId: loaderNodeId,
    field: "unet_name",
  });
  return {
    id: "director-" + workflowId,
    name: "MiniMax H3 导演台",
    family: "导演台",
    description: "当前页面的完整 API 工作流",
    mode: "multi-reference",
    promptRequired: false,
    requiredInputs: [],
    optionalInputs: [],
    parameters: [],
    mapping,
    template,
    output: { nodeId: outputIds[0], field: "*", kind: "video" },
    additionalOutputs: outputIds
      .slice(1)
      .map((id) => ({ nodeId: id, field: "*", kind: "video" })),
    runninghub: {
      workflowId,
      baseUrl,
      kind: "workflow",
      sourceFormat: "api-workflow",
      includeWorkflowJson: true,
    },
  };
}

function receiptDefinition(receipt: DirectorReceipt): WorkflowDefinition {
  return {
    id: "director-" + receipt.workflowId,
    name: "MiniMax H3 导演台",
    family: "导演台",
    description: "恢复已提交的导演台任务",
    mode: "multi-reference",
    promptRequired: false,
    requiredInputs: [],
    optionalInputs: [],
    parameters: [],
    mapping: [],
    output: receipt.outputs[0] ?? {
      nodeId: "director-output",
      field: "*",
      kind: "video",
    },
    additionalOutputs: receipt.outputs.slice(1),
    runninghub: {
      workflowId: receipt.workflowId,
      baseUrl: receipt.site,
      kind: "workflow",
    },
  };
}

export function validateDirectorRunSelection(timeline: Record<string, any>) {
  const count = Array.isArray(timeline.segments) ? timeline.segments.length : 0;
  directorRunSelection(timeline, count);
}

export async function runDirector(options: {
  canvasId: string;
  nodeId?: string;
  snapshot: DirectorSnapshot;
  workflowId: string;
  instanceType: RunningHubInstanceType;
  connection: Connection;
  media: Record<string, string>;
  onState: (run: DirectorRun) => void;
  resumeTaskId?: string;
  resumeRun?: DirectorRun;
}) {
  const { canvasId, nodeId, workflowId, onState } = options;
  const sessionId = directorSessionId(canvasId, nodeId);
  if (running.has(sessionId)) return;
  const initialProject = useStore.getState().project,
    owner = initialProject.id;
  const assetsAtStart = structuredClone(initialProject.assets);
  const snapshotAtStart = structuredClone(options.snapshot);
  const session = {
    abort: new AbortController(),
    client: undefined as RunningHubClient | undefined,
    taskId: options.resumeTaskId,
    remoteCancelConfirmed: false,
    remoteCompleted: false,
  };
  const savedCanvas = initialProject.canvases.find(
    (canvas) => canvas.id === canvasId,
  );
  const saved = nodeId
    ? (savedCanvas?.nodes.find((node) => node.id === nodeId)?.data.director as
        { run?: DirectorRun } | undefined)
    : savedCanvas?.director;
  const previous = options.resumeRun ?? (saved?.run as DirectorRun | undefined);
  const restoring = !!session.taskId && previous?.taskId === session.taskId;
  const receipt: DirectorReceipt =
    restoring && previous?.receipt
      ? structuredClone(previous.receipt)
      : {
          version: 1,
          workflowId,
          site: options.connection.baseUrl,
          instanceType: options.instanceType,
          clientId: crypto.randomUUID(),
          requestId: crypto.randomUUID(),
          taskId: session.taskId,
          outputs: [],
          downloads: [],
        };
  if (restoring) receipt.runProgress = recordedDirectorProgress(previous!);
  receipt.downloads = [
    ...new Map(
      receipt.downloads.map((item) => [
        normalizeDirectorOutputKey(item.key),
        { ...item, key: normalizeDirectorOutputKey(item.key) },
      ]),
    ).values(),
  ];
  const timing: DirectorTiming = {
    startedAt: Date.now(),
    uploadMs: 0,
    downloadMs: 0,
    importMs: 0,
    saveMs: 0,
    ...(restoring ? (previous?.timing ?? receipt.timing) : undefined),
  };
  receipt.timing = timing;
  session.remoteCompleted = timing.remoteCompletedAt !== undefined;
  let outputDownloads: OutputDownloads | undefined;
  let syncPhase: DirectorRun["syncPhase"];
  let activeDownloads = 0,
    downloadStarted = 0;
  const measured = async <T>(
    field: "uploadMs" | "importMs" | "saveMs",
    operation: () => Promise<T>,
  ): Promise<T> => {
    const started = Date.now();
    try {
      return await operation();
    } finally {
      timing[field] += Math.max(0, Date.now() - started);
    }
  };
  const save = () => measured("saveMs", () => useStore.getState().save(true));
  running.set(sessionId, session);
  const live = () => {
    const project = useStore.getState().project,
      canvas = project.canvases.find((item) => item.id === canvasId);
    return (
      project.id === owner &&
      !!canvas &&
      (!nodeId || canvas.nodes.some((node) => node.id === nodeId))
    );
  };
  const requireLive = () => {
    session.abort.signal.throwIfAborted();
    if (!live())
      throw new Error("原导演台已关闭或项目已切换，本次未继续提交。");
  };
  const attachOutput = (asset: Asset, key: string, index: number) => {
    if (live() && nodeId && session.taskId)
      useStore.getState().editProject((project) =>
        attachDirectorOutput(project, {
          canvasId,
          nodeId,
          taskId: session.taskId!,
          fileKey: key,
          asset,
          index,
        }),
      );
  };
  const emit = (status: string, message: string) => {
    // Keep progress and interrupted receipts current even while another file is prefetched.
    if (activeDownloads > 0) {
      const now = Date.now();
      timing.downloadMs += Math.max(0, now - downloadStarted);
      downloadStarted = now;
    }
    receipt.taskId = session.taskId;
    if (live())
      onState({
        taskId: session.taskId,
        workflowId,
        site: receipt.site,
        status,
        message,
        timing: structuredClone(timing),
        runProgress: receipt.runProgress
          ? { ...receipt.runProgress }
          : undefined,
        syncPhase: status === "saving" ? syncPhase : undefined,
        outputIds: [
          ...new Set(
            receipt.downloads
              .map((item) => item.assetId)
              .filter((id) => useStore.getState().project.assets[id]),
          ),
        ],
        receipt: structuredClone(receipt),
      });
  };
  try {
    requireLive();
    if (!options.connection.token.trim())
      throw new Error("请在设置中保存 RunningHub CN Key。");
    if (!/^\d{1,32}$/.test(workflowId))
      throw new Error("请填写完整工作流 ID。");
    if (
      receipt.workflowId !== workflowId ||
      receipt.site.replace(/\/$/, "") !==
        options.connection.baseUrl.replace(/\/$/, "")
    )
      throw new Error("恢复任务必须使用原工作流和 RunningHub 站点。");
    const connection = {
      ...options.connection,
      timeoutMinutes: Number.POSITIVE_INFINITY,
    };
    let definition: WorkflowDefinition;
    if (!session.taskId) {
      const reader = new RunningHubClient(connection);
      emit(
        "loading",
        workflowId === DIRECTOR_WORKFLOW_ID
          ? "正在加载已导出的完整 API 工作流…"
          : "正在读取完整 API 工作流…",
      );
      requireLive();
      const graph = await readDirectorWorkflow(
        reader,
        workflowId,
        session.abort.signal,
      );
      requireLive();
      let snapshot = snapshotAtStart;
      validateDirectorRunSelection(snapshot.timeline);
      const prompts = [
        snapshot.values.global_prompt,
        snapshot.timeline.global?.prompt,
        ...(snapshot.timeline.segments ?? []).map(
          (segment: any) => segment.prompt,
        ),
      ];
      if (!prompts.some((value) => typeof value === "string" && value.trim()))
        throw new Error("请输入公共提示词或分组提示词。");
      // Validate model and output compatibility before uploading any user media.
      directorDefinition(graph, snapshot, workflowId, connection.baseUrl);
      receipt.runProgress = directorSnapshotProgress(snapshot);
      emit("uploading", "正在上传导演台引用素材…");
      requireLive();
      snapshot = {
        ...snapshot,
        timeline: await measured("uploadMs", () =>
          uploadDirectorTimeline(
            snapshot.timeline,
            options.media,
            assetsAtStart,
            async (asset) => {
              requireLive();
              const blob = await getBlob(asset.id, asset.mime);
              requireLive();
              const uploaded = await reader.uploadAsset(
                blob,
                asset.name,
                "",
                session.abort.signal,
              );
              requireLive();
              return uploaded;
            },
          ),
        ),
      };
      requireLive();
      definition = await attachRunningHubExecutionContract(
        directorDefinition(graph, snapshot, workflowId, connection.baseUrl),
      );
      requireLive();
      receipt.outputs = [
        definition.output,
        ...(definition.additionalOutputs ?? []),
      ].map(({ nodeId, field, kind }) => ({ nodeId, field, kind }));
    } else {
      // Only the immutable receipt is needed to query an accepted task. No prompts survive a save.
      definition = receiptDefinition(receipt);
      emit("queued", "正在恢复查询原 RunningHub 任务…");
    }
    requireLive();
    const client = new RunningHubClient(
      connection,
      receipt.clientId,
      definition,
      receipt.instanceType,
    );
    session.client = client;
    if (!session.taskId) {
      session.abort.signal.throwIfAborted();
      emit("submitting", "正在提交导演台时间轴…");
      requireLive();
      await save();
      requireLive();
      try {
        session.taskId = await client.queuePrompt(
          definition.template!,
          receipt.requestId,
        );
      } catch (reason) {
        session.taskId =
          (await client
            .findSubmittedPrompt(receipt.requestId)
            .catch(() => null)) ?? undefined;
        if (!session.taskId) throw reason;
      }
      timing.submittedAt = Date.now();
      emit("queued", "任务已提交，等待 RunningHub…");
      await save();
      if (session.abort.signal.aborted) {
        await client.cancel(session.taskId);
        session.remoteCancelConfirmed = true;
        session.abort.signal.throwIfAborted();
      }
    }
    const history = await client.waitForCompletion(
      session.taskId,
      (state) =>
        emit(
          state.status ?? "generating",
          state.status === "queued" ? "RunningHub 排队中" : "RunningHub 执行中",
        ),
      session.abort.signal,
      definition.template,
    );
    if (!live()) return;
    session.remoteCompleted = true;
    timing.remoteCompletedAt ??= Date.now();
    const providerDuration = history.runningHubTiming?.providerDurationSeconds;
    if (
      typeof providerDuration === "number" &&
      Number.isFinite(providerDuration) &&
      providerDuration >= 0
    )
      timing.providerDurationSeconds = providerDuration;
    emit("saving", "RunningHub 已完成，正在读取本地结果…");
    // Legacy receipts may lack descriptors; RH result node IDs are authoritative when available.
    const outputNodes = Object.keys(history.outputs ?? {});
    const resultDefinition =
      !receipt.outputs.length && outputNodes.length
        ? {
            ...definition,
            output: {
              nodeId: outputNodes[0],
              field: "*",
              kind: "video" as const,
            },
            additionalOutputs: outputNodes.slice(1).map((nodeId) => ({
              nodeId,
              field: "*",
              kind: "video" as const,
            })),
          }
        : definition;
    const collected = collectWorkflowOutputs(history, resultDefinition);
    const files = [
      ...new Map(
        collected.files.map((file) => [directorOutputKey(file), file]),
      ).values(),
    ];
    if (!files.length)
      throw new Error(
        "RunningHub 已完成，但没有返回视频文件。可恢复查询原任务。",
      );
    const verified = new Map<string, Asset>();
    const missing: RemoteFile[] = [];
    for (const file of files) {
      requireLive();
      const key = directorOutputKey(file),
        previous = receipt.downloads.find((item) => item.key === key);
      const asset =
        previous && useStore.getState().project.assets[previous.assetId];
      if (asset) {
        try {
          const blob = await getBlob(asset.id, asset.mime);
          requireLive();
          const expectedKind = collected.fileKinds[outputKey(file)];
          if (
            blob.size > 0 &&
            blob.size === asset.size &&
            (expectedKind === "file" || asset.kind === expectedKind)
          ) {
            verified.set(key, asset);
            continue;
          }
        } catch {
          /* Missing or incomplete cache is downloaded again. */
        }
      }
      missing.push(file);
    }
    requireLive();
    if (missing.length) delete timing.completedAt;
    outputDownloads = createOutputDownloads(
      missing,
      async (file, signal) => {
        requireLive();
        if (activeDownloads++ === 0) downloadStarted = Date.now();
        try {
          return await client.getOutput(file, signal);
        } finally {
          // Parallel transfers count once in elapsed network time.
          if (--activeDownloads === 0)
            timing.downloadMs += Math.max(0, Date.now() - downloadStarted);
        }
      },
      session.abort.signal,
    );
    for (const [index, file] of files.entries()) {
      requireLive();
      const key = directorOutputKey(file),
        cached = verified.get(key);
      if (cached) {
        attachOutput(cached, key, index);
        continue;
      }
      syncPhase = "download";
      emit(
        "saving",
        `RunningHub 已完成，正在下载结果（${index + 1}/${files.length}）…`,
      );
      const blob = await outputDownloads.take(file);
      requireLive();
      if (!blob.size)
        throw new Error(
          "RunningHub 返回了空结果文件，可恢复查询原任务重新下载。",
        );
      // Error pages occasionally arrive with HTTP 200; never import them as videos.
      if (/(?:text\/html|application\/(?:json|problem\+json))/i.test(blob.type))
        throw new Error(
          "RunningHub 结果下载返回了错误页面，未保存为视频。可恢复查询原任务。",
        );
      syncPhase = "import";
      emit("saving", `正在导入生成结果（${index + 1}/${files.length}）…`);
      const asset = await measured("importMs", () =>
        importAsset(blob, file.filename),
      );
      requireLive();
      const expectedKind = collected.fileKinds[outputKey(file)];
      if (expectedKind !== "file" && asset.kind !== expectedKind)
        throw new Error("输出媒体类型与工作流定义不符，可恢复查询原任务。");
      useStore.getState().editProject((project) => ({
        ...project,
        assets: { ...project.assets, [asset.id]: asset },
      }));
      const priorIndex = receipt.downloads.findIndex(
        (item) => item.key === key,
      );
      if (priorIndex >= 0)
        receipt.downloads[priorIndex] = { key, assetId: asset.id };
      else receipt.downloads.push({ key, assetId: asset.id });
      attachOutput(asset, key, index);
      syncPhase = "save";
      emit("saving", `正在保存生成结果（${index + 1}/${files.length}）…`);
      await save();
    }
    timing.completedAt ??= Date.now();
    emit("completed", "已完成");
    await save();
    emit("completed", "已完成");
  } catch (reason) {
    const status =
      reason instanceof ExecutionError
        ? reason.status
        : session.remoteCancelConfirmed ||
            (session.abort.signal.aborted && !session.taskId)
          ? "cancelled"
          : session.taskId
            ? "interrupted"
            : "failed";
    emit(
      status,
      reason instanceof Error
        ? readableRunningHubError(reason.message).replaceAll(
            options.connection.token || "__none__",
            "[已隐藏]",
          )
        : "导演台执行失败。",
    );
    if (live()) await save().catch(() => {});
  } finally {
    outputDownloads?.close();
    session.client?.disconnect();
    if (running.get(sessionId) === session) running.delete(sessionId);
  }
}

export async function cancelDirector(canvasId: string, nodeId?: string) {
  const session = running.get(directorSessionId(canvasId, nodeId));
  if (!session) return;
  if (session.taskId && session.client && !session.remoteCompleted) {
    await session.client.cancel(session.taskId);
    session.remoteCancelConfirmed = true;
  }
  session.abort.abort(new Error("已停止当前任务。"));
}
