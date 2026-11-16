import { importAsset } from "../assets/assets";
import { executionWorkflows, nodeComputeState } from "../compute/providers";
import { generationPreparationIdentity } from "./preparation-context";
import { getBlob } from "../projects/storage";
import { resolveInputs } from "../semantic/resolver";
import { resolvePrompt } from "../semantic/prompt";
import { useStore } from "../stores/store";
import { busyPhases, type Asset, type GenerationTask, type RemoteFile } from "../types";
import { findWorkflow } from "../workflow/catalog";
import { createMuseJob, getMuseJob, resumeMuseJob, getMuseOutput, uploadMuseReference, cancelMuseJob } from "../muse/client";
import { museReferenceKind } from "../muse/media";

type MuseJob = Awaited<ReturnType<typeof getMuseJob>>;
type Session = { abort: AbortController; current: () => boolean };
const sessions = new Map<string, Session>();
const preparing = new Map<string, { taskId?: string }>();
const cancelling = new Map<string, Promise<void>>();
const interruptedMessage = "已停止本机等待；Muse 原任务可能继续运行，可恢复查询。";

function ownsTask(task: GenerationTask, projectId: string) {
  const project = useStore.getState().project, current = project.tasks[task.taskId];
  return project.id === projectId && !!current && current.executorType === "muse" &&
    current.requestId === task.requestId && current.clientId === task.clientId &&
    current.canvasId === task.canvasId && current.nodeId === task.nodeId;
}

function pause(signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const cancelled = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", cancelled); resolve(); }, 1500);
    signal.addEventListener("abort", cancelled, { once: true });
  });
}

const fileKey = (file: RemoteFile) => file.url ?? file.filename;
const message = (reason: unknown) => reason instanceof Error ? reason.message : "Muse 任务未完成，请恢复查询原任务。";
function rejectedSubmission(reason: unknown) {
  const status = reason && typeof reason === "object" && "status" in reason ? reason.status : undefined;
  return typeof status === "number" && status >= 400 && status < 500 && status !== 408;
}

/** Muse accepts media references directly; no synthetic ComfyUI graph is built. */
export async function generateMuse(canvasId: string, nodeId: string) {
  const state = nodeComputeState(useStore.getState(), canvasId, nodeId), projectId = state.project.id;
  const canvas = state.project.canvases.find(item => item.id === canvasId);
  const node = canvas?.nodes.find(item => item.id === nodeId);
  if (!canvas || !node?.data.generation || state.navigating) return;
  const preparationKey = JSON.stringify([projectId, canvasId, nodeId]);
  if (preparing.has(preparationKey)) return;
  if (Object.values(state.project.tasks).some(task => task.canvasId === canvasId && task.nodeId === nodeId &&
    (busyPhases.includes(task.status) || task.status === "interrupted"))) {
    state.notify("此节点已有未结束任务，请恢复查询原任务。");
    return;
  }
  const preparation: { taskId?: string } = {};
  preparing.set(preparationKey, preparation);
  let task: GenerationTask | undefined;
  let preparationExpired = false;
  const anchor = generationPreparationIdentity(state, canvasId, nodeId);
  const stopPreparation = useStore.subscribe(current => {
    if (generationPreparationIdentity(current, canvasId, nodeId) !== anchor) preparationExpired = true;
  });
  try {
    state.patchNode(nodeId, { generationFeedback: undefined }, canvasId);
    const generation = node.data.generation;
    const workflow = findWorkflow(executionWorkflows(state), generation.workflowId);
    if (!workflow?.muse) throw new Error("请先选择 Muse 图片或视频生成。");
    const kind = workflow.muse.kind;
    if (workflow.output.kind !== kind || (kind === "image" ? node.data.kind !== "image-generation" : node.data.kind !== "video"))
      throw new Error("Muse 生成类型与当前节点不匹配，请重新选择。");
    const resolved = resolvePrompt(canvas, nodeId, generation.prompt, workflow);
    if (resolved.missingMentions.length) throw new Error("提示词引用的素材已断开或被删除，请重新连接素材。");
    if (resolved.extraSlotTexts) throw new Error("连接的文本超过当前生成能力的输入数量。");
    if (resolved.texts.some(input => !input.text.trim())) throw new Error("连接的文本为空，请先填写内容。");
    if (!resolved.prompt.trim()) throw new Error("请输入提示词，或连接一个有内容的文本节点。");
    if (generation.negativePrompt.trim()) throw new Error("Muse 网页暂不支持独立负面提示词，请清空该项或将要求写入提示词。");
    const inputs = resolveInputs(canvas, nodeId, workflow, state.project.assets);
    if (inputs.some(input => !["image", "video", "audio"].includes(input.asset.kind))) throw new Error("Muse 参考素材仅支持图片、视频和音频。");
    const ratioParameter = workflow.parameters.find(parameter => parameter.key === "aspectRatio");
    const aspectRatio = generation.params.aspectRatio ?? ratioParameter?.default ?? "auto";
    if (typeof aspectRatio !== "string" || ratioParameter?.options && !ratioParameter.options.includes(aspectRatio))
      throw new Error("Muse 画幅设置无效，请重新选择。");
    const id = crypto.randomUUID();
    const created: GenerationTask = {
      taskId: id, promptId: null, requestId: id, clientId: crypto.randomUUID(), executorType: "muse",
      projectId, canvasId, nodeId, nodeTitle: node.data.title, status: "uploading", submissionState: "not-submitted",
      createdAt: Date.now(), updatedAt: Date.now(), outputs: [],
      connection: { name: "Muse 网页账号", baseUrl: "/api/muse", authHeader: "", authPrefix: "", timeoutMinutes: 0 },
      workflow: structuredClone(workflow),
      input: { prompt: resolved.prompt, negativePrompt: "", texts: structuredClone(resolved.texts), params: { aspectRatio }, assets: structuredClone(inputs) },
    };
    task = created;
    preparation.taskId = created.taskId;
    state.createTask(created);
    await useStore.getState().save(true);
    if (preparing.get(preparationKey) !== preparation) return;
    if (ownsTask(created, projectId) && ["completed", "failed", "cancelled", "interrupted"].includes(useStore.getState().project.tasks[created.taskId].status)) return;
    if (preparationExpired || !ownsTask(created, projectId)) {
      if (ownsTask(created, projectId)) {
        useStore.getState().patchTask(created.taskId, { status: "failed", error: "生成准备已停止，尚未向 Muse 提交任务。" });
        await useStore.getState().save();
      }
      return;
    }
    stopPreparation();
    await executeMuse(created.taskId, false);
  } catch (reason) {
    if (preparing.get(preparationKey) !== preparation || preparationExpired || useStore.getState().project.id !== projectId) return;
    if (task && ownsTask(task, projectId) && ["completed", "cancelled", "interrupted"].includes(useStore.getState().project.tasks[task.taskId].status)) return;
    if (task && ownsTask(task, projectId)) {
      useStore.getState().patchTask(task.taskId, { status: "failed", error: message(reason) });
      await useStore.getState().save();
    } else if (!task) state.patchNode(nodeId, { generationFeedback: { status: "failed", error: message(reason) } }, canvasId);
    useStore.getState().notify(message(reason));
  } finally { stopPreparation(); if (preparing.get(preparationKey) === preparation) preparing.delete(preparationKey); }
}

async function executeMuse(taskId: string, resume: boolean) {
  const task = useStore.getState().project.tasks[taskId];
  if (!task || task.executorType !== "muse" || sessions.has(taskId) || ["completed", "cancelled", "failed"].includes(task.status)) return;
  const projectId = task.projectId ?? useStore.getState().project.id;
  const abort = new AbortController();
  let expired = false, attempted = resume || !!task.promptId, finished = !!task.remoteOutputs?.length;
  const session: Session = { abort, current: () => !expired && sessions.get(taskId) === session && ownsTask(task, projectId) };
  sessions.set(taskId, session);
  const unsubscribe = useStore.subscribe(() => {
    if (!expired && !ownsTask(task, projectId)) { expired = true; abort.abort(); }
  });
  const scope = () => {
    if (!session.current()) throw new DOMException("Project changed", "AbortError");
    abort.signal.throwIfAborted();
  };
  const patch = (value: Partial<GenerationTask>) => {
    if (!session.current()) return false;
    const current = useStore.getState().project.tasks[taskId];
    if (Object.entries(value).every(([key, next]) => current[key as keyof GenerationTask] === next)) return false;
    useStore.getState().patchTask(taskId, value);
    return true;
  };
  const save = async () => { scope(); await useStore.getState().save(true); scope(); };
  try {
    scope();
    const kind = task.workflow.muse?.kind;
    if (kind !== "image" && kind !== "video") throw new Error("Muse 任务缺少原生成类型。");
    let files = task.remoteOutputs;
    if (!files?.length) {
      let job: MuseJob;
      let resumeOriginal = resume;
      if (resume) {
        // GET is the only first recovery operation, even if the create response was lost.
        job = await getMuseJob(taskId, abort.signal);
        scope();
      } else {
        const references = [];
        if (task.input.assets.some(input => !["image", "video", "audio"].includes(input.asset.kind)))
          throw new Error("Muse 参考素材仅支持图片、视频和音频。");
        for (const input of task.input.assets) {
          const blob = await getBlob(input.asset.id, input.asset.mime);
          scope();
          const mime = blob.type || input.asset.mime;
          if (museReferenceKind(mime) !== input.asset.kind) throw new Error("参考素材的文件类型与素材类型不符，或格式不受支持。");
          if (!blob.size) throw new Error("参考素材为空，请重新选择素材。");
          const uploaded = await uploadMuseReference(taskId, blob.type ? blob : new Blob([blob], { type: mime }), input.asset.name, abort.signal);
          scope();
          references.push(uploaded);
        }
        patch({ status: "submitting", promptId: taskId, submissionState: undefined, error: undefined, progress: undefined });
        await save();
        attempted = true;
        try {
          job = await createMuseJob({ id: taskId, kind, prompt: task.input.prompt, aspectRatio: String(task.input.params.aspectRatio ?? "auto"), references }, abort.signal);
        } catch (reason) {
          // The bridge rejects invalid/unauthorized requests before accepting a job.
          // Transport errors and timeouts provide no such confirmation.
          if (rejectedSubmission(reason)) attempted = false;
          throw reason;
        }
      }
      while (true) {
        scope();
        if (job.id !== taskId) throw new Error("Muse 返回了其他任务，已停止接收结果。");
        if (job.status === "interrupted" && (resumeOriginal || job.recovery === "reconnect")) {
          patch({ status: "loading", promptId: taskId, submissionState: undefined, error: undefined, progress: undefined,
            details: "正在重新连接 Muse 并查询原任务，不会重新发送生成请求。" });
          await save();
          job = await resumeMuseJob(taskId, abort.signal);
          scope();
          if (job.id !== taskId) throw new Error("Muse 返回了其他任务，已停止接收结果。");
          // Process this response directly: an unchanged interruption needs user
          // attention, not another resume POST. Later disconnects can reconnect.
        }
        resumeOriginal = false;
        if (job.conversationUrl && /^https:\/\/muse\.ai(?:\/|\/thread\/(?!new$)[a-zA-Z0-9_-]+)?$/.test(job.conversationUrl) && useStore.getState().project.tasks[taskId].muse?.conversationUrl !== job.conversationUrl) {
          patch({ muse: { conversationUrl: job.conversationUrl } });
          await save();
        }
        if (job.status === "failed" || job.status === "interrupted") {
          patch({ status: job.status, promptId: taskId, submissionState: undefined, error: job.error || job.message || "Muse 任务未完成。", progress: undefined });
          await save();
          return;
        }
        if (job.status === "cancelled") {
          patch({ status: "cancelled", details: job.message || "本机 Muse 任务已停止；已发送到 Muse 的生成可能继续运行。", error: undefined, progress: undefined });
          await save();
          return;
        }
        if (job.status === "completed") {
          finished = true;
          if (!job.outputs?.length) throw new Error("Muse 已完成，但尚未收到有效媒体结果。请恢复原任务。");
          const seen = new Set<string>();
          files = [];
          for (const output of job.outputs) {
            if (seen.has(output.id)) continue;
            seen.add(output.id);
            files.push({ filename: output.name, url: output.url, type: "output" });
          }
          patch({ status: "saving", promptId: taskId, submissionState: undefined, remoteOutputs: files, progress: undefined, error: undefined,
            details: "Muse 已完成，正在把成品写入原节点。" });
          await save();
          break;
        }
        if (patch({ status: job.status, promptId: taskId, submissionState: undefined, details: job.message, progress: undefined, error: undefined })) await save();
        await pause(abort.signal);
        job = await getMuseJob(taskId, abort.signal);
      }
    }
    const downloads = [...(task.downloadedOutputs ?? [])], assets: Asset[] = [];
    const kinds = { ...task.remoteOutputKinds };
    patch({ status: "saving", progress: undefined, error: undefined, details: "Muse 已完成，正在把成品写入原节点。" });
    for (const file of files ?? []) {
      scope();
      const key = fileKey(file), saved = downloads.find(entry => fileKey(entry.file) === key);
      if (saved) {
        let local: Blob | undefined;
        try { local = await getBlob(saved.asset.id, saved.asset.mime); } catch { /* Re-download missing local files only. */ }
        scope();
        if (local?.size && local.size === saved.asset.size && saved.asset.kind === kind &&
          (local.type || saved.asset.mime).toLowerCase().startsWith(kind + "/")) {
          assets.push(saved.asset); kinds[key] = saved.asset.kind; continue;
        }
      }
      if (!file.url) throw new Error("Muse 结果缺少下载地址。");
      const blob = await getMuseOutput(file.url, abort.signal);
      scope();
      if (!blob.size || !blob.type.toLowerCase().startsWith(kind + "/"))
        throw new Error("Muse 返回的文件类型与生成类型不符，未将网页、封面或附件当作生成结果。");
      const asset = { ...await importAsset(blob, file.filename), inLibrary: false };
      scope();
      if (asset.kind !== kind) throw new Error("Muse 结果未能识别为正确的图片或视频。");
      const index = downloads.findIndex(entry => fileKey(entry.file) === key);
      if (index >= 0) downloads[index] = { file, asset }; else downloads.push({ file, asset });
      kinds[key] = asset.kind;
      useStore.getState().editProject(project => ({ ...project, assets: { ...project.assets, [asset.id]: asset } }));
      patch({ downloadedOutputs: [...downloads], remoteOutputKinds: { ...kinds } });
      await save();
      assets.push(asset);
    }
    scope();
    if (!assets.length) throw new Error("Muse 尚未返回有效媒体结果。");
    useStore.getState().complete(taskId, assets, {
      id: taskId, canvasId: task.canvasId, nodeId: task.nodeId, nodeTitle: task.nodeTitle,
      workflowId: task.workflow.id, prompt: task.input.prompt, negativePrompt: task.input.negativePrompt,
      params: task.input.params, inputs: task.input.assets.map(input => ({ assetId: input.asset.id, role: input.semantic })),
      outputs: assets.map(asset => asset.id), promptId: taskId, createdAt: task.createdAt,
    });
    patch({ details: "Muse 成品已保存到原节点。" });
    await save();
    useStore.getState().notify("Muse 生成完成，结果已保存到原节点。");
  } catch (reason) {
    if (!session.current()) return;
    const current = useStore.getState().project.tasks[taskId];
    if (!current || ["completed", "cancelled"].includes(current.status)) return;
    patch({ status: attempted || finished ? "interrupted" : "failed", progress: undefined,
      error: abort.signal.aborted ? interruptedMessage : message(reason),
      ...(!attempted ? { promptId: null } : {}),
      submissionState: attempted ? undefined : "not-submitted" });
    await useStore.getState().save();
  } finally {
    unsubscribe();
    if (sessions.get(taskId) === session) sessions.delete(taskId);
  }
}

export async function resumeMuseTask(taskId: string) {
  const task = useStore.getState().project.tasks[taskId];
  if (task?.executorType !== "muse" || task.status !== "interrupted") return;
  if (!task.promptId && task.submissionState === "not-submitted") {
    useStore.getState().patchTask(taskId, { status: "failed", error: "该任务在提交前中断，请重新生成。" });
    await useStore.getState().save();
    return;
  }
  await executeMuse(taskId, true);
}

export async function cancelMuseTask(taskId: string) {
  const task = useStore.getState().project.tasks[taskId];
  if (task?.executorType !== "muse" || ["completed", "failed"].includes(task.status)) return;
  const projectId = task.projectId ?? useStore.getState().project.id;
  if (!ownsTask(task, projectId)) return;
  const key = JSON.stringify([projectId, taskId, task.requestId, task.clientId, task.canvasId, task.nodeId]);
  const active = cancelling.get(key);
  if (active) return active;
  let expired = false;
  const current = () => !expired && ownsTask(task, projectId);
  const unsubscribe = useStore.subscribe(() => { if (!ownsTask(task, projectId)) expired = true; });

  // Stop local preparation immediately. An old finally must not unlock a new run.
  const preparationKey = JSON.stringify([projectId, task.canvasId, task.nodeId]);
  if (preparing.get(preparationKey)?.taskId === taskId) preparing.delete(preparationKey);
  const session = sessions.get(taskId);
  if (session?.current()) { sessions.delete(taskId); session.abort.abort(); }
  useStore.getState().patchTask(taskId, { status: "cancelled", progress: undefined, error: undefined,
    details: "画布已停止继续执行，正在从本机 Muse 队列移除任务…" });

  // Do not reuse the observer's aborted signal: the bridge must receive this
  // request even after polling stopped, or before create reached the bridge.
  const operation: Promise<void> = Promise.resolve().then(async () => {
    let confirmed = false;
    try {
      const job = await cancelMuseJob(taskId);
      if (!current()) return;
      if (job.id !== taskId || !["cancelled", "completed", "failed"].includes(job.status))
        throw new Error("本机 Muse 服务尚未确认该任务已停止。");
      confirmed = true;
      const details = job.message || "已从本机 Muse 队列移除；已发送到 Muse 的生成可能继续运行。";
      useStore.getState().patchTask(taskId, { status: "cancelled", progress: undefined, error: undefined,
        details });
      await useStore.getState().save();
      if (!current()) return;
      useStore.getState().notify(details);
    } catch (reason) {
      if (!current()) return;
      if (confirmed) {
        useStore.getState().notify("Muse 本机任务已停止，但停止状态暂未保存：" + message(reason));
        return;
      }
      useStore.getState().patchTask(taskId, { status: "interrupted", progress: undefined,
        error: "本机 Muse 队列停止尚未确认，请再次停止任务。" + message(reason),
        details: "画布已停止继续执行；本机队列及 Muse 网页上的任务可能仍在运行。" });
      await useStore.getState().save().catch(() => {});
      if (!current()) return;
    } finally {
      unsubscribe();
      if (cancelling.get(key) === operation) cancelling.delete(key);
    }
  });
  cancelling.set(key, operation);
  return operation;
}

export const hasActiveMuseTasks = () => sessions.size > 0 || preparing.size > 0 || cancelling.size > 0;
