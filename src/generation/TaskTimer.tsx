import { useEffect, useState } from "react";
import type { GenerationTask } from "../types";
import { isTimerRunning } from "./elapsed";
import { runningHubTimingDisplay } from "./runninghub-timing";

export function TaskTimer({ task }: { task: GenerationTask }) {
  const [, tick] = useState(0);
  const running = isTimerRunning(task);
  useEffect(() => {
    if (!running) return;
    const interval = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(interval);
  }, [task.taskId, running]);
  const display = runningHubTimingDisplay(task);
  return (
    <span
      className="node-timer"
      role="timer"
      aria-label={
        task.executorType === "runninghub" ? display.text : "生成用时"
      }
      title={display.title}
    >
      {display.text}
    </span>
  );
}
