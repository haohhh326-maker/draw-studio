import { resolvePrompt } from "../semantic/prompt";
import { generateMuse, resumeMuseTask, cancelMuseTask, hasActiveMuseTasks } from "./muse-pipeline";
import { resolveInputs } from "../semantic/resolver";
import { selectWorkflowOutput } from "../workflow/execution";
import { findWorkflow } from "../workflow/catalog";
import { importDependencyMessage } from "../workflow/import-execution";
import { useStore, workflowCredentialValues } from "../stores/store";
import {
  ComfyUIClient,
  ApiError,
  ExecutionError,
  collectWorkflowOutputs,
  friendlyError,
} from "../comfyui/client";
import { buildWorkflow, validateDefinition } from "../workflow-adapter/adapter";
import { taskDirectories, uploadName, outputKey } from "../comfyui/files";
import { getBlob } from "../projects/storage";
import { importAsset } from "../assets/assets";
import { createOutputDownloads } from "./output-downloads";
import { RunningHubClient, validateRunningHubMediaInputs } from "../runninghub/client";
import { normalizeRunningHubInstanceType } from "../runninghub/instance-types";
import { prepareNativeRunningHubMedia } from "../runninghub/native-media";
import { normalizeNativeRunningHubOutputFields } from "../runninghub/native-output-fields";
import { isRunningHubNativeConnection, NativeRunningHubAccountError, normalizeRunningHubNativeConnection } from "../runninghub/native-connection";
import { activeConnection, executionWorkflows, computeEndpoint, runningHubSite, isRunningHubProvider, nodeComputeState } from "../compute/providers";
import { generationPreparationIdentity } from "./preparation-context";
import { autoDLTaskPower } from "../autodl/client";
import { applyWorkflowCredentials, cleanWorkflowCredentials, credentialParameterValues, detectWorkflowCredentials, missingWorkflowCredentials, redactWorkflowCredentialText } from "../workflow/credentials";
import {
  busyPhases,
  type GenerationTask,
  type CanvasNode,
  type ExecutorType,
  type Connection,
  type ApiWorkflow,
  type WorkflowDefinition,
  type Asset,
  type RunningHubInstanceType,
} from "../types";

type Executor = {
  createClient: (connection: Connection, clientId: string, workflow: WorkflowDefinition, instanceType?: RunningHubInstanceType) => ComfyUIClient;
};
const executors: Record<Exclude<ExecutorType, "muse">, Executor> = {
  comfyui: { createClient: (c, id) => new ComfyUIClient(c, id) },
  runninghub: { createClient: (c, id, workflow, instanceType) => new RunningHubClient(c, id, workflow, instanceType) },
};
// This map holds live handles only. Task identity and state live exclusively in Project.tasks.
const sessions = new Map<
  string,
  { client: ComfyUIClient; abort: AbortController; submitting: boolean; remoteCancelConfirmed: boolean; isCurrent: () => boolean }
>();
// Guard the durable task write against duplicate clicks.
const preparing = new Set<string>();
const cancelling = new Set<string>();
function ownsTask(task: GenerationTask, ownerProjectId: string) {
  const project = useStore.getState().project, current = project.tasks[task.taskId];
  return project.id === ownerProjectId && !!current && (current.projectId == null || current.projectId === ownerProjectId) &&
    current.requestId === task.requestId && current.clientId === task.clientId &&
    current.canvasId === task.canvasId && current.nodeId === task.nodeId && current.executorType === task.executorType;
}
/** Keep the saved output ancestry without interpreting custom-node schemas or model names. */
function outputBranch(graph: ApiWorkflow, roots: string[]): ApiWorkflow {
  const keep = new Set<string>(), pending = [...roots];
  while (pending.length) {
    const id = pending.pop()!;
    if (keep.has(id) || !Object.hasOwn(graph, id)) continue;
    keep.add(id);
    for (const value of Object.values(graph[id].inputs))
      if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && Number.isInteger(value[1]))
        pending.push(value[0]);
  }
  return Object.fromEntries(Object.entries(graph).filter(([id]) => keep.has(id)));
}
function credentials(task: GenerationTask): Connection {
  const state = useStore.getState();
  const native = task.executorType === "comfyui" && isRunningHubNativeConnection(task.connection);
  const snapshot = native ? normalizeRunningHubNativeConnection({ ...task.connection, token: "" }) : { ...task.connection, token: "" };
  const current = task.executorType === "runninghub"
    ? computeEndpoint(state.runningHubConnection.baseUrl) === computeEndpoint(task.connection.baseUrl) ? state.runningHubConnection
      : state.runningHubConnections[runningHubSite(task.connection.baseUrl)]
    : native ? state.comfyConnectionProfiles.native
      : isRunningHubNativeConnection(state.connection) ? state.comfyConnectionProfiles.cloud : state.connection;
  const normalizedCurrent = isRunningHubNativeConnection(current) ? normalizeRunningHubNativeConnection(current) : current;
  // The two official CN tiers share credentials, but the task retains its original tier.
  const same = native ? isRunningHubNativeConnection(normalizedCurrent)
    : normalizedCurrent.baseUrl.replace(/\/$/, "") === snapshot.baseUrl.replace(/\/$/, "");
  return { ...snapshot, token: same ? normalizedCurrent.token : "" };
}
export async function generate(canvasId: string, nodeId: string) {
  const state = nodeComputeState(useStore.getState(), canvasId, nodeId);
  if (state.computeProvider === "muse") return generateMuse(canvasId, nodeId);
  const startedAt = Date.now();
  const canvas = state.project.canvases.find((c) => c.id === canvasId),
    node = canvas?.nodes.find((n) => n.id === nodeId);
  if (!canvas || !node?.data.generation) return;
  if (state.navigating) return;
  const projectId = state.project.id,
    workflowId = node.data.generation.workflowId,
    preparationKey = JSON.stringify([projectId, canvasId, nodeId]);
  if (preparing.has(preparationKey)) return;
  if (
    Object.values(state.project.tasks).some(
      (t) =>
        t.nodeId === nodeId &&
        t.canvasId === canvasId &&
        (busyPhases.includes(t.status) || t.status === "interrupted"),
    )
  ) {
    state.notify("此节点已有未结束任务，请在任务面板恢复查询或取消。");
    return;
  }
  preparing.add(preparationKey);
  let createdTaskId: string | undefined;
  let preparationExpired = false;
  let stopPreparation = () => {};
  try {
    state.patchNode(nodeId, { generationFeedback: undefined }, canvasId);
    const definition = findWorkflow(executionWorkflows(state), workflowId);
    const runninghub = isRunningHubProvider(state.computeProvider);
    const instanceType = runninghub ? normalizeRunningHubInstanceType(node.data.generation.runningHubInstanceType) : undefined;
    if (!definition) throw new Error(state.computeProvider === "runninghub-workflow" ? "请先读取并选择 RunningHub ComfyUI 工作流。" : runninghub ? "请先添加并选择 RunningHub AI 应用。" : "请选择一个工作流。");
    if (runninghub !== !!definition.runninghub) throw new Error("所选工作流与当前算力不匹配，请重新选择。");
    if (state.computeProvider === "runninghub-workflow" && definition.runninghub?.kind === "app") throw new Error("请选择 RunningHub ComfyUI 工作流；AI 应用使用独立入口。");
    const selectedConnection = activeConnection(state);
    if (!runninghub && isRunningHubNativeConnection(selectedConnection))
      throw new Error("RunningHub 原生 ComfyUI 入口已停用。请切换到独立的「RunningHub ComfyUI 工作流」，粘贴工作流链接后运行。已有任务仍可恢复查询。");
    const connection = isRunningHubNativeConnection(selectedConnection) ? normalizeRunningHubNativeConnection(selectedConnection) : selectedConnection;
    if (runninghub && computeEndpoint(definition.runninghub!.baseUrl) !== computeEndpoint(connection.baseUrl))
      throw new Error("该 RunningHub 工作流属于其他站点，请切换站点或重新添加。");
    if (runninghub && !connection.token.trim()) throw new Error("请先在算力设置中填写 RunningHub API Key。");
    if (definition.library?.importStatus === "pending")
      throw new Error("此工作流尚未完成自动转换。请在工作流目录中点击「重新自动转换」，完成后再运行。" + importDependencyMessage(definition));
    let w = cleanWorkflowCredentials(runninghub ? definition : selectWorkflowOutput(definition, node.data.generation.params));
    let parameterValues = node.data.generation.params;
    if (runninghub) {
      const anchor = generationPreparationIdentity(useStore.getState(), canvasId, nodeId);
      stopPreparation = useStore.subscribe(current => {
        const scoped = nodeComputeState(current, canvasId, nodeId);
        if (generationPreparationIdentity(current, canvasId, nodeId) !== anchor ||
          findWorkflow(executionWorkflows(scoped), workflowId) !== definition)
          preparationExpired = true;
      });
      const { prepareRunningHubRun } = await import("../runninghub/run-bindings");
      const prepared = await prepareRunningHubRun(w, parameterValues);
      if (preparationExpired) return;
      stopPreparation();
      w = prepared.workflow;
      parameterValues = prepared.params;
    }
    const missing = missingWorkflowCredentials(w, workflowCredentialValues(state, w));
    if (missing.length) { state.setCredentialWorkflow(w); throw new Error("此工作流需要单独填写 API Key：" + missing.map(field => field.label).join("、")); }
    validateDefinition(w);
    const currentCanvas = canvas, currentNode = node, generation = currentNode.data.generation!;
    const resolved = resolvePrompt(currentCanvas, nodeId, generation.prompt, w);
    if (resolved.missingMentions.length)
      throw new Error("提示词引用的素材「" + resolved.missingMentions.map(mention => mention.label || "素材").join("、") + "」已断开连接或被删除，请重新连接素材或删除对应的 @ 标签。");
    if (resolved.extraSlotTexts) throw new Error("连接的文本超过此工作流的文本输入数量，请检查连线。");
    const emptyText = resolved.texts.find((input) => !input.text.trim());
    if (emptyText)
      throw new Error(
        "连接的文本「" + emptyText.title + "」为空，请填写内容。",
      );
    if (!resolved.prompt && w.promptRequired !== false)
      throw new Error("请输入提示词，或连接一个有内容的文本节点。");
    const promptNode: CanvasNode = {
      ...currentNode,
      data: {
        ...currentNode.data,
        generation: { ...generation, prompt: resolved.prompt, params: { ...parameterValues, ...resolved.slotParams, ...credentialParameterValues(w, workflowCredentialValues(state, w)) } },
      },
    };
    const inputs = resolveInputs(currentCanvas, nodeId, w, state.project.assets);
    const checked = buildWorkflow(
      applyWorkflowCredentials(w, workflowCredentialValues(state, w)),
      promptNode,
      inputs,
      Object.fromEntries(inputs.map((i) => [i.asset.id, "validate-only"])),
    );
    if (runninghub) validateRunningHubMediaInputs(w, checked.workflow);
    for (const field of detectWorkflowCredentials(w)) if (field.parameterKey) delete checked.params[field.parameterKey];
    const { token: _, ...endpoint } = connection;
    const task: GenerationTask = {
      taskId: crypto.randomUUID(),
      promptId: null,
      submissionState: "not-submitted",
      executorType: runninghub ? "runninghub" : "comfyui",
      ...(runninghub ? { runningHubInstanceType: instanceType } : {}),
      requestId: crypto.randomUUID(),
      clientId: crypto.randomUUID(),
      projectId: state.project.id,
      canvasId,
      nodeId,
      nodeTitle: currentNode.data.title,
      status: "uploading",
      createdAt: startedAt,
      updatedAt: Date.now(),
      connection: endpoint,
      workflow: structuredClone(w),
      input: {
        prompt: resolved.prompt,
        texts: structuredClone(resolved.texts),
        negativePrompt: generation.negativePrompt,
        params: checked.params,
        assets: structuredClone(inputs),
      },
      outputs: [],
    };
    task.staging = taskDirectories(task.taskId);
    createdTaskId = task.taskId;
    state.createTask(task);
    // A durable local task and seed exist before any network or paid generation is submitted.
    await useStore.getState().save(true);
    if (!ownsTask(task, projectId)) return;
    await execute(task.taskId, false);
  } catch (e) {
    if (createdTaskId && useStore.getState().project.id === projectId)
      useStore
        .getState()
        .patchTask(createdTaskId, { status: "failed", ...friendlyError(e) });
    else if (!preparationExpired && useStore.getState().project.id === projectId) {
      useStore.getState().patchNode(nodeId, { generationFeedback: { status: "failed", ...friendlyError(e) } }, canvasId);
    }
    if (!preparationExpired && useStore.getState().project.id === projectId) useStore.getState().notify(friendlyError(e).error);
  } finally {
    stopPreparation();
    preparing.delete(preparationKey);
  }
}
export async function resumeTask(taskId: string) {
  const task = useStore.getState().project.tasks[taskId];
  if (task?.executorType === "muse") return resumeMuseTask(taskId);
  if (!task || task.status !== "interrupted" || sessions.has(taskId)) return;
  if (!task.promptId && (task.submissionState === "not-submitted" || task.details === "not-submitted")) {
    useStore.getState().patchTask(taskId, {
      status: "failed",
      error: "该任务在提交前中断，请重新生成。",
    });
    await useStore.getState().save();
    return;
  }
  await execute(taskId, true);
}
async function waitForAutoDLComfyUI(client: ComfyUIClient, signal: AbortSignal, onStatus: (message: string) => void) {
  const deadline = Date.now() + 10 * 60_000;
  onStatus("AutoDL 已开机，正在等待 ComfyUI 服务就绪…");
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    try {
      const stats = await client.json<{ system?: unknown; devices?: unknown[] }>("/system_stats", {
        signal: AbortSignal.any([signal, AbortSignal.timeout(Math.min(10_000, deadline - Date.now()))]),
      });
      signal.throwIfAborted();
      if (stats && typeof stats === "object" && (stats.system || Array.isArray(stats.devices))) return;
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof ApiError && [401, 403].includes(error.status))
        throw new Error("AutoDL 已开机，但 ComfyUI 服务鉴权失败，请检查 ComfyUI 连接 Token。");
    }
    await new Promise<void>((resolve, reject) => {
      const finish = () => { signal.removeEventListener("abort", cancel); resolve(); };
      const timer = setTimeout(finish, Math.min(2_000, Math.max(0, deadline - Date.now())));
      const cancel = () => { clearTimeout(timer); signal.removeEventListener("abort", cancel); reject(signal.reason); };
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
    });
  }
  throw new Error("AutoDL 已开机，但 ComfyUI 服务长时间未就绪，本次未提交生成任务。请检查实例内的 ComfyUI 启动配置。");
}
async function connectAutoDLComfyUI(client: ComfyUIClient, signal: AbortSignal) {
  signal.throwIfAborted();
  let cancel = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    cancel = () => { client.disconnect(); reject(signal.reason); };
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
  });
  try {
    signal.throwIfAborted();
    const connected = client.connect(signal).finally(() => { if (signal.aborted) client.disconnect(); });
    await Promise.race([connected, cancelled]);
  } finally { signal.removeEventListener("abort", cancel); }
}
async function execute(taskId: string, resume: boolean) {
  const task = useStore.getState().project.tasks[taskId];
  if (!task || sessions.has(taskId) || task.status === "cancelled") return;
  if (task.executorType === "muse") return resumeMuseTask(taskId);
  const factory = executors[task.executorType];
  if (!factory) {
    useStore
      .getState()
      .patchTask(taskId, { status: "failed", error: "不支持的任务执行器。" });
    return;
  }
  const client = factory.createClient(credentials(task), task.clientId, task.workflow, task.runningHubInstanceType),
    abort = new AbortController();
  let executionSignal = abort.signal;
  const runninghub = task.executorType === "runninghub";
  const native = !runninghub && isRunningHubNativeConnection(client.connection);
  const remote = runninghub || native;
  // Older persisted tasks omitted projectId. Capture their current owner once;
  // never fall back to whichever project happens to be visible in a callback.
  const ownerProjectId = task.projectId ?? useStore.getState().project.id;
  let scopeExpired = false;
  const session = { client, abort, submitting: false, remoteCancelConfirmed: false, isCurrent: () => true };
  session.isCurrent = () => !scopeExpired && ownsTask(task, ownerProjectId) && sessions.get(taskId) === session;
  const taskCredentials = workflowCredentialValues(useStore.getState(), task.workflow);
  sessions.set(taskId, session);
  // A canvas switch keeps observing its original node. A replaced project/task
  // expires this owner permanently, even if that saved project is reopened later.
  const unsubscribe = useStore.subscribe(() => {
    if (!scopeExpired && !ownsTask(task, ownerProjectId)) { scopeExpired = true; abort.abort(); }
  });
  const requireScope = () => {
    if (!session.isCurrent()) throw new Error("原任务所属项目已变化，已停止本次界面查询。");
  };
  const timing = (value: NonNullable<GenerationTask["runningHubTiming"]>) => {
    if (!runninghub || !session.isCurrent()) return;
    patch({ runningHubTiming: { ...useStore.getState().project.tasks[taskId]?.runningHubTiming, ...value } });
  };
  type MeasuredPhase = "prepareMs" | "submitMs" | "observeMs" | "downloadMs" | "importMs" | "checkpointMs";
  const addTiming = (phase: MeasuredPhase, ms: number) => {
    const prior = useStore.getState().project.tasks[taskId]?.runningHubTiming?.[phase] ?? 0;
    timing({ [phase]: prior + Math.max(0, ms) });
  };
  const measured = async <T>(phase: MeasuredPhase, work: () => Promise<T>) => {
    const started = Date.now();
    try { return await work(); }
    finally { if (runninghub) addTiming(phase, Date.now() - started); }
  };
  const save = async (force = false) => {
    requireScope();
    await measured("checkpointMs", () => useStore.getState().save(force));
    requireScope();
  };
  let submitted = !!task.promptId,
    attempted = false,
    submissionRejected = false,
    serverFinished = false;
  const patch = (p: Partial<GenerationTask>) => {
    if (!session.isCurrent()) return;
    const current = useStore.getState().project.tasks[taskId];
    if (remote && current && ["completed", "cancelled"].includes(current.status)) return;
    useStore.getState().patchTask(taskId, p);
  };
  const saving = (message: string) => {
    if (executionSignal.aborted) return;
    const warnings = useStore.getState().project.tasks[taskId]?.outputWarnings ?? [];
    patch({ savingMessage: message, details: [message, ...warnings].join("\n") });
  };
  const downloadMessage = (received: number, total?: number) => {
    const divisor = (total ?? received) >= 1024 * 1024 ? 1024 * 1024 : 1024;
    const unit = divisor === 1024 ? "KB" : "MB";
    return `正在下载结果 ${(received / divisor).toFixed(1)}${total ? ` / ${(total / divisor).toFixed(1)}` : ""} ${unit}`;
  };
  let outputDownloads: ReturnType<typeof createOutputDownloads> | undefined;
  let autoDLLease: Awaited<ReturnType<typeof autoDLTaskPower>>;
  const prepareStarted = Date.now();
  try {
    patch({
      status: resume ? "queued" : "uploading",
      error: undefined,
      progress: undefined,
      savingMessage: undefined,
    });
    executionSignal.throwIfAborted();
    if (!runninghub && !native && client.connection.autodl?.instanceUuid) {
      autoDLLease = await autoDLTaskPower(client.connection, {
        taskId, attemptId: crypto.randomUUID(), signal: abort.signal,
        onStatus: message => patch({ details: message }),
      });
      if (autoDLLease) executionSignal = AbortSignal.any([abort.signal, autoDLLease.signal]);
      requireScope();
      executionSignal.throwIfAborted();
      if (autoDLLease) await waitForAutoDLComfyUI(client, executionSignal, message => patch({ details: message }));
      requireScope();
      executionSignal.throwIfAborted();
    }
    try {
      // Resuming RH only observes an accepted task; its current input schema is
      // irrelevant and must not block recovery after the workflow was edited.
      if (!task.remoteOutputs?.length && task.outputText === undefined && !(runninghub && resume))
        await (autoDLLease ? connectAutoDLComfyUI(client, executionSignal) : native ? client.connect(abort.signal) : client.connect());
    } catch (e) {
      if (runninghub) throw e;
      patch({ details: String(e) });
    }
    requireScope();
    executionSignal.throwIfAborted();
    let promptId = task.promptId;
    if (resume) {
      promptId ??= await (native || autoDLLease ? client.findSubmittedPrompt(task.requestId, executionSignal) : client.findSubmittedPrompt(task.requestId));
      requireScope();
      if (!promptId)
        throw new Error(
          "尚未找到原任务。可能提交未成功，或服务器已清理历史；不会自动重新提交。",
        );
    } else {
      const staging = task.staging ?? taskDirectories(taskId);
      // Check every local input before uploading any of them.
      const blobs = new Map<string, Blob>();
      for (const input of task.input.assets) {
        if (blobs.has(input.asset.id)) continue;
        const blob = await getBlob(input.asset.id, input.asset.mime);
        requireScope();
        if (!blob.size) throw new Error("输入素材为空：" + input.asset.name);
        blobs.set(input.asset.id, blob);
      }
      const uploads = { ...staging.uploads };
      const uploaded: Record<string, string> = {};
      for (const input of task.input.assets) {
        if (uploaded[input.asset.id]) continue;
        executionSignal.throwIfAborted();
        const file = await client.uploadAsset(
          blobs.get(input.asset.id)!,
          uploadName(input.asset.name),
          staging.inputSubfolder,
          executionSignal,
        );
        requireScope();
        uploads[input.asset.id] = file;
        uploaded[input.asset.id] = file.inputName;
        patch({ staging: { ...staging, uploads: { ...uploads } } });
        await save(true);
      }
      const snapshotNode: CanvasNode = {
        id: task.nodeId,
        type: "media",
        position: { x: 0, y: 0 },
        data: {
          kind:
            task.workflow.output.kind === "image"
              ? "image-generation"
              : ["text", "file"].includes(task.workflow.output.kind)
                ? "tool"
                : (task.workflow.output.kind as "video" | "audio"),
          title: task.nodeTitle,
          generation: { ...task.input, workflowId: task.workflow.id, taskId },
        },
      };
      const missing = missingWorkflowCredentials(task.workflow, taskCredentials);
      if (missing.length) throw new Error("请先填写此工作流的 API Key：" + missing.map(field => field.label).join("、"));
      snapshotNode.data.generation!.params = { ...snapshotNode.data.generation!.params, ...credentialParameterValues(task.workflow, taskCredentials) };
      const built = buildWorkflow(
        applyWorkflowCredentials(task.workflow, taskCredentials),
        snapshotNode,
        task.input.assets,
        uploaded,
        task.workflow.runninghub?.bindingMode === "selected" ? undefined : staging.outputPrefix,
      );
      if (task.executorType === "comfyui")
        built.workflow = outputBranch(built.workflow, [task.workflow.output.nodeId, ...(task.workflow.additionalOutputs ?? []).map(output => output.nodeId)]);
      if (native) built.workflow = await prepareNativeRunningHubMedia(built.workflow, Object.values(uploads),
        classType => client.json("/object_info/" + encodeURIComponent(classType), { signal: executionSignal }),
        () => client.json("/object_info", { signal: executionSignal }));
      requireScope();
      executionSignal.throwIfAborted();
      patch({
        status: "submitting",
        // Persist the uncertain boundary before sending the generation request.
        // Upload diagnostics and task recovery metadata must stay independent.
        submissionState: undefined,
        details: undefined,
        executionWorkflow: cleanWorkflowCredentials({ ...task.workflow, template: built.workflow }).template,
      });
      await save(true);
      executionSignal.throwIfAborted();
      if (runninghub) addTiming("prepareMs", Date.now() - prepareStarted);
      attempted = true;
      session.submitting = true;
      try {
        promptId = await measured("submitMs", () => client.queuePrompt(built.workflow, task.requestId, runninghub || autoDLLease ? executionSignal : undefined));
        requireScope();
      } catch (e) {
        submissionRejected =
          (e instanceof ApiError && e.status >= 400 && e.status < 500) ||
          e instanceof ExecutionError || e instanceof NativeRunningHubAccountError;
        throw e;
      } finally {
        session.submitting = false;
      }
    }
    requireScope();
    submitted = true;
    if (runninghub && !task.runningHubTiming?.submittedAt && !resume) timing({ submittedAt: Date.now() });
    if (task.executorType === "runninghub") useStore.setState({ runningHubConnectionState: "connected" });
    else if (computeEndpoint(useStore.getState().connection.baseUrl) === computeEndpoint(client.connection.baseUrl)) useStore.setState({ connectionState: "connected" });
    // An accepted ID can still arrive just after cancellation when the
    // transport ignores abort or its response was already buffered. Save that
    // ID before cancelling the paid task; never return to a queued UI state.
    if (remote && abort.signal.aborted) {
      patch({ status: "interrupted", promptId, submissionState: undefined,
        error: "已取得原任务 ID，正在确认 RunningHub 取消结果。" });
      await save(true);
      await client.cancel(promptId!);
      requireScope();
      session.remoteCancelConfirmed = true;
      throw new DOMException("Aborted", "AbortError");
    }
    patch({ status: "queued", promptId, submissionState: undefined, details: undefined });
    await save(true);
    if (abort.signal.aborted) {
      await client.cancel(promptId!);
      requireScope();
      session.remoteCancelConfirmed = true;
      throw new DOMException("Aborted", "AbortError");
    }
    executionSignal.throwIfAborted();
    let files = task.remoteOutputs;
    let textResult = task.outputText;
    let fileKinds = { ...(task.remoteOutputKinds ?? {}) };
    let automaticFiles = task.remoteAutomaticFiles ?? [];
    let outputWarnings = [...(task.outputWarnings ?? [])];
    let textFirst = task.outputTextFirst ?? task.workflow.output.kind === "text";
    if (!files?.length && textResult === undefined) {
      const history = await measured("observeMs", () => client.waitForCompletion(
        promptId!,
        (p) => patch(p),
        executionSignal,
        useStore.getState().project.tasks[taskId]?.executionWorkflow ?? task.executionWorkflow ?? task.workflow.template,
      ));
      requireScope();
      // Remote execution has finished even when its result shape needs repair.
      // Do not describe a receipt/download failure as an uncertain submission.
      serverFinished = true;
      if (runninghub && history.runningHubTiming?.providerDurationSeconds !== undefined)
        timing({ providerDurationSeconds: history.runningHubTiming.providerDurationSeconds });
      const result = collectWorkflowOutputs(native ? normalizeNativeRunningHubOutputFields(history, task.workflow) : history, task.workflow);
      files = result.files.map(file => ({ ...result.fileSources[outputKey(file)], ...file }));
      textResult = result.text; fileKinds = result.fileKinds; textFirst = result.textFirst;
      automaticFiles = result.automaticFiles; outputWarnings = result.warnings;
    }
    serverFinished = true;
    if (runninghub && !task.runningHubTiming?.remoteFinishedAt && !task.remoteOutputs?.length && task.outputText === undefined)
      timing({ remoteFinishedAt: Date.now() });
    // Some RH image apps return a bundled ZIP before their individual PNGs.
    // Receive the media itself, not the redundant bundle labelled as an image.
    // Keep explicit file outputs and archive-only results intact.
    const standaloneMedia = (files ?? []).some(file => /\.(?:png|jpe?g|webp|gif|bmp|tiff?|avif|heic|svg|ico|mp4|webm|mov|avi|mkv|m4v|flv|mpe?g|mp3|wav|ogg|flac|opus|m4a|aac|wma)$/i.test(file.filename));
    const receiveFiles = (files ?? []).filter(file => {
      const kind = fileKinds[outputKey(file)] ?? task.workflow.output.kind;
      return !standaloneMedia || !["image", "video", "audio"].includes(kind) || !/\.(?:zip|7z|rar|tar|tgz|gz)$/i.test(file.filename);
    });
    if (receiveFiles.length < (files?.length ?? 0)) {
      const warning = "已接收单独返回的图片、视频或音频，附带压缩包不作为媒体结果。";
      if (!outputWarnings.includes(warning)) outputWarnings.push(warning);
    }
    patch({
      status: "saving",
      progress: undefined,
      savingMessage: "正在保存任务记录",
      remoteOutputs: files,
      remoteOutputKinds: { ...fileKinds },
      remoteAutomaticFiles: automaticFiles,
      outputWarnings,
      details: ["正在保存任务记录", ...outputWarnings].join("\n"),
      outputText: textResult,
      outputTextFirst: textFirst,
    });
    await save(true);
    const downloads = [...(task.downloadedOutputs ?? [])];
    const assets = [];
    let textAsset = textResult !== undefined ? task.outputTextAsset : undefined;
    if (textResult !== undefined) {
      if (textAsset) {
        try {
          const local = await getBlob(textAsset.id, textAsset.mime);
          requireScope();
          if (textAsset.kind !== "text" || local.size !== textAsset.size || await local.text() !== textResult) throw new Error("本地文本结果不完整");
        } catch { textAsset = undefined; }
      }
      if (!textAsset) {
        requireScope();
        saving("正在写入本地文本结果");
        textAsset = { ...await measured("importMs", () => importAsset(new Blob([textResult], { type: "text/plain" }), "result.txt")), inLibrary: false };
        requireScope();
        const savedText = textAsset;
        useStore.getState().editProject(p => ({ ...p, assets: { ...p.assets, [savedText.id]: savedText } }));
        patch({ outputTextAsset: textAsset });
        saving("正在保存结果记录");
        await save(true);
      }
      if (textFirst) assets.push(textAsset);
    }
    const seenFiles = new Set<string>();
    const verifiedDownloads = new Map<string, Asset>();
    const downloadProgress = new Map<string, { received: number; total?: number }>();
    let activeResultKey: string | undefined;
    if (runninghub) {
      const missing = new Map<string, NonNullable<typeof files>[number]>();
      for (const file of receiveFiles) {
        executionSignal.throwIfAborted();
        const key = outputKey(file);
        const saved = downloads.find(entry => outputKey(entry.file) === key);
        if (saved) {
          try {
            const local = await getBlob(saved.asset.id, saved.asset.mime);
            requireScope();
            if (local.size === saved.asset.size) {
              fileKinds[key] = saved.asset.kind;
              verifiedDownloads.set(key, saved.asset);
              continue;
            }
          } catch { /* Fetch only missing or incomplete local results. */ }
        }
        missing.set(key, file);
      }
      let activeDownloads = 0, downloadStarted = 0;
      outputDownloads = createOutputDownloads([...missing.values()], async (file, signal) => {
        requireScope();
        if (activeDownloads++ === 0) downloadStarted = Date.now();
        try {
          const key = outputKey(file);
          const blob = await (client as RunningHubClient).getOutput(file, signal, (received, total) => {
            downloadProgress.set(key, { received, total });
            if (activeResultKey === key) saving(downloadMessage(received, total));
          });
          requireScope();
          const priorBytes = useStore.getState().project.tasks[taskId]?.runningHubTiming?.downloadBytes ?? 0;
          timing({ downloadBytes: priorBytes + blob.size });
          return blob;
        } finally {
          // Count overlapping network requests once; local import/save can overlap this interval.
          if (--activeDownloads === 0) addTiming("downloadMs", Date.now() - downloadStarted);
        }
      }, executionSignal);
    }
    for (const file of receiveFiles) {
      executionSignal.throwIfAborted();
      const key = outputKey(file);
      if (seenFiles.has(key)) continue;
      seenFiles.add(key);
      const verified = verifiedDownloads.get(key);
      if (verified) { assets.push(verified); continue; }
      const saved = downloads.find(
        (entry) => outputKey(entry.file) === outputKey(file),
      );
      if (saved && !runninghub) {
        try {
          const local = await getBlob(saved.asset.id, saved.asset.mime);
          requireScope();
          if (local.size !== saved.asset.size)
            throw new Error("本地结果不完整");
          fileKinds[key] = saved.asset.kind;
          assets.push(saved.asset);
          continue;
        } catch {
          /* Re-download only missing or incomplete local files. */
        }
      }
      requireScope();
      activeResultKey = key;
      const progress = downloadProgress.get(key);
      saving(progress ? downloadMessage(progress.received, progress.total) : "正在下载结果");
      const blob = outputDownloads ? await outputDownloads.take(file) : await client.getOutput(file, executionSignal,
        native ? { promptId: promptId!, onlyOutput: files?.length === 1 } : undefined);
      requireScope();
      executionSignal.throwIfAborted();
      activeResultKey = undefined;
      if (!blob.size) throw new Error("服务器返回了空结果文件。");
      if (/^text\/html(?:;|$)/i.test(blob.type) && !/\.html?$/i.test(file.filename)) {
        const header = await blob.slice(0, 1024).text();
        requireScope();
        if (/^\s*(?:<!doctype\s+html|<html\b)/i.test(header))
          throw new Error("结果下载返回了网页，未收到有效的生成文件。可恢复原任务结果。");
      }
      // The workflow's declared output kind is only an import hint. It must not
      // turn a PNG into a file attachment or reject a GIF from a video saver.
      saving("正在写入本地结果");
      const asset = { ...await measured("importMs", () => importAsset(blob, file.filename)), inLibrary: false };
      requireScope();
      executionSignal.throwIfAborted();
      fileKinds[key] = asset.kind;
      const index = downloads.findIndex(
        (entry) => outputKey(entry.file) === outputKey(file),
      );
      if (index >= 0) downloads[index] = { file, asset };
      else downloads.push({ file, asset });
      // Add local assets immediately so portable project exports retain partial downloads.
      useStore.getState().editProject((p) => ({
        ...p,
        assets: { ...p.assets, [asset.id]: asset },
      }));
      patch({ downloadedOutputs: [...downloads], remoteOutputKinds: { ...fileKinds } });
      saving("正在保存结果记录");
      await save(true);
      assets.push(asset);
    }
    if (textAsset && !textFirst) assets.push(textAsset);
    requireScope();
    executionSignal.throwIfAborted();
    patch({ remoteOutputKinds: { ...fileKinds }, savingMessage: undefined,
      details: ["结果已保存到画布", ...outputWarnings].join("\n") });
    if (remote && useStore.getState().project.tasks[taskId]?.status === "cancelled") return;
    useStore.getState().complete(taskId, assets, {
      id: taskId,
      canvasId: task.canvasId,
      nodeId: task.nodeId,
      nodeTitle: task.nodeTitle,
      workflowId: task.workflow.id,
      prompt: task.input.prompt,
      negativePrompt: task.input.negativePrompt,
      params: task.input.params,
      inputs: task.input.assets.map((i) => ({
        assetId: i.asset.id,
        role: i.semantic,
      })),
      outputs: assets.map((a) => a.id),
      promptId: promptId!,
      createdAt: task.createdAt,
      ...(runninghub ? { runningHubInstanceType: task.runningHubInstanceType ?? "default" } : {}),
    });
    await save(true);
    useStore.getState().notify("生成完成，结果已保存到原节点。");
  } catch (cause) {
    const e = autoDLLease?.signal.aborted ? autoDLLease.signal.reason : cause;
    if (!session.isCurrent()) return;
    const current = useStore.getState().project.tasks[taskId];
    if (remote && current && ["completed", "cancelled"].includes(current.status)) return;
    const aborted = e instanceof DOMException && e.name === "AbortError" || e instanceof NativeRunningHubAccountError && e.aborted;
    const uncertain = !submissionRejected && (submitted || attempted || resume);
    const status =
      remote && serverFinished
        ? "interrupted"
        : remote && aborted && uncertain && !session.remoteCancelConfirmed && !serverFinished
          ? "interrupted"
          : e instanceof ExecutionError
            ? e.status
            : aborted
              ? "cancelled"
              : serverFinished
                ? "interrupted"
                : uncertain
                  ? "interrupted"
                  : "failed";
    const described = friendlyError(e);
    if (remote && serverFinished && aborted) {
      described.error = "RunningHub 已完成，结果下载或本机保存中断。可恢复原任务结果，不会重新生成。";
    } else if (remote && serverFinished && e instanceof TypeError && /fetch|network|load failed/i.test(e.message)) {
      described.error = "RunningHub 已完成，结果下载连接中断。可恢复原任务结果，不会重新生成。";
    } else if (remote && aborted && status === "interrupted") {
      described.error = "已请求取消，但尚未确认 RunningHub 是否接受或停止原任务。请核对原任务，不会自动重新提交。";
    }
    if (described.error) described.error = redactWorkflowCredentialText(described.error, taskCredentials);
    if (described.details) described.details = redactWorkflowCredentialText(described.details, taskCredentials);
    patch({
      status,
      progress: undefined,
      savingMessage: undefined,
      ...described,
      ...(e instanceof ExecutionError && e.execution ? { execution: e.execution } : {}),
      submissionState: uncertain ? undefined : "not-submitted",
    });
    await useStore.getState().save();
  } finally {
    outputDownloads?.close();
    unsubscribe();
    client.disconnect();
    if (sessions.get(taskId) === session) sessions.delete(taskId);
    if (autoDLLease) {
      try { await autoDLLease.release(); }
      catch (error) { useStore.getState().notify("AutoDL 自动关机未确认，请在算力设置中检查并重试关机：" + friendlyError(error).error); }
    }
  }
}
export async function cancelTask(taskId: string) {
  const task = useStore.getState().project.tasks[taskId];
  if (task?.executorType === "muse") return cancelMuseTask(taskId);
  if (!task || ["completed", "failed", "cancelled"].includes(task.status))
    return;
  const session = sessions.get(taskId);
  const runninghub = task.executorType === "runninghub";
  const ownerProjectId = task.projectId ?? useStore.getState().project.id;
  const cancellationKey = JSON.stringify([ownerProjectId, taskId, task.requestId]);
  if (cancelling.has(cancellationKey)) return;
  cancelling.add(cancellationKey);
  let scopeExpired = false;
  const isCurrent = () => !scopeExpired && ownsTask(task, ownerProjectId) && (!session || session.isCurrent());
  const unsubscribe = useStore.subscribe(() => {
    if (!ownsTask(task, ownerProjectId)) scopeExpired = true;
  });
  try {
    if (!isCurrent()) return;
    // RH is already finished during receipt/local saving. Stop this local
    // observer immediately without asking the finished paid task to cancel.
    // Detach the session so a pending local import cannot later complete it,
    // and recovery can start even when an old storage operation is still pending.
    if ((runninghub || isRunningHubNativeConnection(task.connection)) && task.status === "saving") {
      useStore.getState().patchTask(taskId, {
        status: "interrupted", progress: undefined, savingMessage: undefined,
        error: "已停止接收结果。RunningHub 原任务已完成，可恢复下载，不会重新生成。",
        details: "已保留原任务和已保存的结果。",
      });
      if (session && sessions.get(taskId) === session) sessions.delete(taskId);
      session?.abort.abort();
      await useStore.getState().save(true);
      return;
    }
    if (!session && !task.promptId && task.status === "uploading") {
      useStore.getState().patchTask(taskId, { status: "cancelled" });
      await useStore.getState().save(true);
      return;
    }
    // Abort the local HTTP wait immediately. The server may already have
    // accepted this paid task, so retain an explicit uncertain, resumable
    // record. execute() still handles a late task ID and cancels that ID.
    if (session && !task.promptId) {
      const uncertainRunningHubSubmit = runninghub && session.submitting;
      if (uncertainRunningHubSubmit) useStore.getState().patchTask(taskId, {
        status: "interrupted", progress: undefined, submissionState: undefined,
        error: "已停止等待提交响应；无法确认 RunningHub 是否接收原任务。请核对原任务，不会自动重新提交。",
      });
      session.abort.abort();
      if (uncertainRunningHubSubmit) await useStore.getState().save(true);
      return;
    }
    const client =
      session?.client ??
      executors[task.executorType].createClient(
        credentials(task),
        task.clientId,
        task.workflow,
      );
    const id =
      task.promptId ?? (await client.findSubmittedPrompt(task.requestId));
    if (!isCurrent()) return;
    if (!id)
      throw new Error(
        "无法确认服务器任务，不能把它标记为已取消。请检查服务器任务记录。",
      );
    await client.cancel(id);
    if (!isCurrent()) return;
    if (session) session.remoteCancelConfirmed = true;
    session?.abort.abort();
    useStore.getState().patchTask(taskId, {
      status: "cancelled",
      promptId: id,
      progress: undefined,
      savingMessage: undefined,
      error: undefined,
      details: undefined,
    });
    await useStore.getState().save(true);
  } catch (e) {
    if (isCurrent()) useStore.getState().notify(friendlyError(e).error);
  } finally {
    unsubscribe();
    cancelling.delete(cancellationKey);
  }
}
export function hasActiveTasks() {
  return sessions.size > 0 || hasActiveMuseTasks();
}
export async function recoverTasks() {
  const tasks = Object.values(useStore.getState().project.tasks).filter(
    (t) => t.status === "interrupted" && (!!t.promptId || t.executorType === "muse"),
  );
  await Promise.allSettled(tasks.map((t) => resumeTask(t.taskId)));
}
