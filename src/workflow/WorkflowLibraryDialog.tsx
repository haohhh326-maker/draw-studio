import { Modal } from "../components/ui";
import { useStore } from "../stores/store";
import { WorkflowLibraryStatus } from "./WorkflowLibraryStatus";
import "./workflow-library-dialog.css";

export function WorkflowLibraryDialog() {
  return (
    <Modal
      title="更新工作流"
      onClose={() => useStore.setState({ modal: null })}
    >
      <div className="workflow-library-dialog">
        <button onClick={() => useStore.setState({ modal: "workflow-import" })}>添加工作流</button>
        <WorkflowLibraryStatus />
      </div>
    </Modal>
  );
}
