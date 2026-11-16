// Application boundary types; the adjacent complete upstream JavaScript is unchanged.
export class WorkflowDeploymentService {
  constructor(options: Record<string, any>);
  createDeployment(id: string, options: Record<string, any>): Promise<Record<string, any>>;
  createBindingSet(id: string, options: Record<string, any>): Promise<Record<string, any>>;
}
export function createPortableWorkflowProjection(workflow: Record<string, any>): Record<string, any>;
export function createStableCapabilityProjection(workflow: Record<string, any>, objectInfo: Record<string, any>): Record<string, any>;
