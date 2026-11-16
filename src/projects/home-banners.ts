import type { HomeCarouselSlide } from "./HomeCarousel";

const image = (name: string) => import.meta.env.BASE_URL + "home/" + name;

export const homeBanners: HomeCarouselSlide[] = [
  {
    id: "welcome", image: image("feature-01.jpg"), eyebrow: "DRAW STUDIO",
    title: "欢迎来到 Draw studio 无限画布",
    description: "一起拥抱这个美好的 AI 时代，一起创作无限可能的影像作品。",
  },
  {
    id: "canvas", image: image("feature-02.webp"), eyebrow: "DRAW STUDIO",
    title: "在一张画布里，\n连接你的所有创意。",
    description: "从参考图到提示词，从图像到视频，让每一个灵感在这里展开。",
  },
  {
    id: "comfyui", image: image("feature-03.jpg"), eyebrow: "DRAW STUDIO",
    title: "连接云端 ComfyUI，\n开启你的生成工作流",
    description: "导入工作流，连接云端工作站，在画布中完成你的影像创作。",
  },
  {
    id: "runninghub", image: image("feature-04.jpg"), eyebrow: "DRAW STUDIO",
    title: "RunningHub 工作流，\n从生成到下一镜头",
    description: "让图像与视频在同一张画布中连接，继续你的故事。",
  },
];
