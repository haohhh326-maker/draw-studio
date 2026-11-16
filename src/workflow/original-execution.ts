import { gunzipSync, strFromU8 } from "fflate";
import compressed from "./original-execution.gz.json" with { type: "json" };
import type { WorkflowDefinition, Parameter } from "../types";

type ExecutionDefinition = Pick<WorkflowDefinition, "template" | "mapping" | "output" | "inputSlots" | "dynamicReferences" | "promptRequired"> & {textParameters: Parameter[]};
export const originalExecution = JSON.parse(strFromU8(gunzipSync(Uint8Array.from(atob(compressed), c => c.charCodeAt(0))))) as Record<string, ExecutionDefinition>;
