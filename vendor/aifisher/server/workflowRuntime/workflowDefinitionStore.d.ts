// Application boundary types; the adjacent complete upstream JavaScript is unchanged.
export class WorkflowDefinitionStore {
  constructor(options: Record<string, any>);
  createDefinition(input: Record<string, any>): Promise<Record<string, any>>;
  readExecutionPlan(id: string): Promise<Record<string, any>>;
}
