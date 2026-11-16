// Application boundary types; the adjacent complete upstream JavaScript is unchanged.
export class WorkflowConfigurationStore {
  constructor(options: Record<string, any>);
  listDeployments(id: string): Promise<Record<string, any>[]>;
  listBindingSets(id: string): Promise<Record<string, any>[]>;
}
