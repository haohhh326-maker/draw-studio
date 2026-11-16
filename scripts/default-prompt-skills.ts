/** Shared generation-model catalog. No workflow IDs, names, folders or hashes belong here. */
export function defaultPromptSkillManifest() {
  const path = (model: string, files: string[]) => files.map(file => `models/${model}/${file}`);
  const task = (id: string, name: string, modes: string[], references: string[] = [], extra: Record<string, unknown> = {}) => ({ id, name, modes, references, ...extra });
  const model = (id: string, name: string, folder: string, modelKeys: string[], tasks: ReturnType<typeof task>[], extra: Record<string, unknown> = {}) =>
    ({ id, name, entry: `models/${folder}/SKILL.md`, modelKeys, tasks, ...extra });
  return { schemaVersion: 2, organization: "shared-rules / generation-model / task", common: {
    entry: "common/prompt-editing/SKILL.md",
    references: Object.fromEntries(["text", "image-generation", "image-edit", "video-generation", "video-edit", "music", "speech-verbatim", "utility"]
      .map(name => [name, [`common/prompt-editing/tasks/${name}.md`]])),
  }, models: [
    model("minimax-h3", "MiniMax H3", "minimax-h3", ["minimax-h3"], [
      task("base", "文本与关键帧视频", ["text-to-video", "image-to-video", "first-last-frame", "last-frame"], path("minimax-h3", ["references/base-en.txt"])),
      task("reference", "多素材参考视频", ["multi-reference", "reference-video", "video-to-video"], path("minimax-h3", ["references/ref-en.txt"])),
    ], { routing: "h3" }),
    model("flux", "FLUX", "flux", ["flux-1", "flux-2", "flux-2-klein"], [
      task("generation", "文生图", ["text-to-image"], path("flux", ["rules/t2i-prompting.md"])),
      task("editing", "图像编辑", ["image-to-image", "multi-reference", "style-transfer"], path("flux", ["rules/i2i-prompting.md", "rules/multi-reference-editing.md"])),
    ], { references: path("flux", ["rules/core-principles.md"]), featureReferences: [
      { modelKeys: ["flux-1"], references: path("flux", ["rules/flux1-models.md"]) },
      { modelKeys: ["flux-2", "flux-2-klein"], references: path("flux", ["rules/flux2-models.md"]) },
    ] }),
    model("qwen-image-21", "Qwen Image 2.1", "qwen-image-2.1", ["qwen-image-2.1"], [
      task("generation", "文生图", ["text-to-image"], path("qwen-image-2.1", ["references/t2i_rules.md"])),
      task("editing", "图像编辑", ["image-to-image", "multi-reference", "style-transfer"], path("qwen-image-2.1", ["references/edit_rules.md"])),
    ], { routing: "qwen21" }),
    model("qwen-image", "Qwen Image", "qwen-image", ["qwen-image", "qwen-image-edit-2511", "qwen-image-2512"], [
      task("generation", "文生图", ["text-to-image"], path("qwen-image", ["references/generation.md"]), { modelKeys: ["qwen-image", "qwen-image-2512"] }),
      task("editing", "图像编辑", ["image-to-image", "multi-reference", "style-transfer"], path("qwen-image", ["references/editing.md"]), { modelKeys: ["qwen-image", "qwen-image-edit-2511"] }),
      task("camera-angle", "多角度 LoRA 控制", ["camera-angle"], path("qwen-image", ["references/angle-vocabulary.md"]), { promptContracts: ["fixed-vocabulary"] }),
    ], { featureReferences: [
      { modelKeys: ["qwen-image-edit-2511"], references: path("qwen-image", ["references/model-2511.md"]) },
      { modelKeys: ["qwen-image-2512"], references: path("qwen-image", ["references/model-2512.md"]) },
      { modelKeys: ["qwen-image-2512"], features: ["film-trigger"], references: path("qwen-image", ["references/qwen2512-artfilm-prompting.zh-CN.md"]) },
    ] }),
    model("krea-2", "Krea 2", "krea-2", ["krea-2"], [
      task("generation", "文生图", ["text-to-image"]),
      task("editing", "参考图与编辑", ["image-to-image", "multi-reference", "style-transfer"], path("krea-2", ["references/reference-style.md"])),
    ], { references: path("krea-2", ["references/expansion.txt"]) }),
    model("z-image", "Z-Image", "z-image", ["z-image"], [
      task("generation", "文生图", ["text-to-image"]), task("editing", "图像编辑", ["image-to-image", "multi-reference", "style-transfer"]),
    ], { references: path("z-image", ["references/model-workflow-notes.md"]) }),
    model("ltx-23", "LTX 2.3", "ltx-2.3", ["ltx-2.3"], [
      task("generation", "文生视频", ["text-to-video"]), task("image-video", "图生视频", ["image-to-video"]),
      task("keyframes", "关键帧视频", ["first-last-frame", "last-frame"]),
      task("reference", "多素材参考", ["multi-reference", "reference-video", "audio-to-video"]),
      task("editing", "视频编辑", ["video-to-video"]),
    ], { references: path("ltx-2.3", ["references/prompt-construction-playbook.md"]), featureReferences: [
      { features: ["audio-conditioned"], references: path("ltx-2.3", ["references/dialogue-audio-lipsync.md"]) },
      { features: ["msr-v2"], references: path("ltx-2.3", ["references/canvas-msr-v2.md"]) },
      { features: ["prompt-relay-global"], references: path("ltx-2.3", ["references/prompt-relay.md"]) },
    ] }),
    model("bernini", "Wan 2.2 Bernini", "bernini", ["wan-2.2-bernini"], [
      task("image-video", "图像参考视频", ["image-to-video", "multi-reference"]),
      task("editing", "视频编辑", ["video-to-video", "reference-video"]),
    ], { references: path("bernini", ["references/reference.md"]) }),
    model("scail2", "SCAIL2", "scail2", ["wan-2.1-scail2"], [
      task("motion-reference", "动作与角色参考", ["image-to-video", "multi-reference", "reference-video", "video-to-video", "motion-transfer"]),
    ], { references: path("scail2", ["references/reference.md"]) }),
    model("wan-22", "Wan 2.2", "wan-2.2", ["wan-2.2", "wan-2.2-remix"], [
      task("image-video", "图生视频与关键帧", ["image-to-video", "first-last-frame", "last-frame"], path("wan-2.2", ["references/i2v-en.txt", "references/i2v-zh.txt"])),
    ]),
    model("music3", "MiniMax Music3", "minimax-music3", ["minimax-music3"], [
      task("music", "音乐描述", ["text-to-audio", "audio-to-audio"]),
    ], { routing: "music3", disclosure: { router: "models/minimax-music3/references/genre-router.md", maxTemplates: 3 } }),
    model("voxcpm2", "VoxCPM2", "voxcpm2", ["voxcpm-2"], [
      task("speech", "朗读正文", ["text-to-speech"], [], { promptContracts: ["verbatim"] }),
    ]),
    model("gpt-image", "GPT Image 2", "gpt-image", ["gpt-image-2"], [
      task("generation", "文生图", ["text-to-image"]), task("editing", "图像编辑", ["image-to-image", "multi-reference"]),
    ]),
    model("nano-banana", "Nano Banana Pro", "nano-banana", ["nano-banana-pro"], [
      task("generation", "文生图", ["text-to-image"]),
      task("editing", "图像编辑", ["image-to-image", "multi-reference"], path("nano-banana", ["skills/core/reference-binding.md", "skills/core/preservation.md", "skills/core/edit-delta.md"])),
    ], { references: path("nano-banana", ["references/00-orchestrator.md", "skills/core/text-layout.md"]) }),
  ] };
}
