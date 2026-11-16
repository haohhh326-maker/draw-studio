import { app } from "../../scripts/app.js";
import { ComfyWidgets } from "../../scripts/widgets.js";

app.registerExtension({
  name: "DrawStudio.PromptOptimizationResult",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "DrawStudioPromptOptimizer") return;
    const previous = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      previous?.apply(this, arguments);
      if (!Array.isArray(message?.text)) return;
      let widget = this.widgets?.find(item => item.name === "optimization_result");
      if (!widget) {
        widget = ComfyWidgets.STRING(this, "optimization_result", ["STRING", { multiline: true }], app).widget;
        widget.options ??= {};
        widget.options.serialize = false;
        if (widget.inputEl) {
          widget.inputEl.readOnly = true;
          widget.inputEl.style.opacity = "0.95";
        }
      }
      widget.value = message.text.join("\n");
      this.setSize(this.computeSize());
      this.setDirtyCanvas(true, true);
    };
  },
});
