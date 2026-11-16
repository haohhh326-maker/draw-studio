import { describe, expect, it, vi } from "vitest";

// Exercise the actual JSX event handlers without opening another browser or
// adding a DOM runtime. Hook state/effects are local to one field instance.
const hooks = vi.hoisted(() => ({ current: undefined as any }));
vi.mock("react", async importOriginal => {
  const react = await importOriginal<typeof import("react")>();
  return {
    ...react,
    useState(initial: unknown) {
      const host = hooks.current, index = host.cursor++;
      if (!(index in host.slots)) host.slots[index] = typeof initial === "function" ? initial() : initial;
      return [host.slots[index], (value: any) => {
        host.slots[index] = typeof value === "function" ? value(host.slots[index]) : value;
      }];
    },
    useRef(initial: unknown) {
      const host = hooks.current, index = host.cursor++;
      return host.slots[index] ??= { current: initial };
    },
    useEffect(effect: () => void, dependencies: unknown[]) {
      const host = hooks.current, index = host.cursor++, previous = host.slots[index];
      if (!previous || dependencies.some((value, i) => !Object.is(value, previous[i]))) {
        host.slots[index] = dependencies;
        host.effects.push(effect);
      }
    },
  };
});
import { DirectorNativeSettings, type DirectorNativeSettingsProps } from "../src/director/DirectorNativeSettings";
import { setDirectorWidgetValues } from "../src/director/upstream-host";

function elements(tree: any): any[] {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  if (!tree || typeof tree !== "object" || !tree.props) return [];
  return [tree, ...elements(tree.props.children)];
}

function fieldHarness(key: string, props: () => DirectorNativeSettingsProps) {
  const host = { cursor: 0, slots: [] as any[], effects: [] as (() => void)[] };
  const once = () => {
    host.cursor = 0;
    hooks.current = host;
    try {
      const field = elements(DirectorNativeSettings(props())).find(element => element.props.field?.key === key);
      const tree = field.type(field.props);
      for (const effect of host.effects.splice(0)) effect();
      return tree;
    } finally { hooks.current = undefined; }
  };
  return () => {
    once(); // Apply changed-prop effects, then expose their rendered state.
    const tree = once();
    return { input: elements(tree).find(element => element.type === "input"), tree };
  };
}

describe("director native field interaction", () => {
  it.each([["steps", "25", 25], ["seed", "90210", 90210], ["cache_name", "current-cache", "current-cache"]])(
    "commits %s to the real host before blur so a focused Ctrl+S or run reads it",
    (key, raw, expected) => {
      const widget = { name: key, value: key === "cache_name" ? "" : 8, callback: vi.fn() };
      const node = { widgets: [widget], _minimaxEditor: { flushTimelineSync: vi.fn() } };
      const changed = vi.fn();
      const onChange = vi.fn(patch => setDirectorWidgetValues(node, patch, changed));
      const render = fieldHarness(key as string, () => ({ values: { [key]: widget.value }, onChange }));
      render().input.props.onChange({ target: { value: raw } });
      // No blur/Enter has occurred; this is the same widget host.read() reads.
      expect(widget.value).toBe(expected);
      expect(changed).toHaveBeenCalledOnce();
      render().input.props.onBlur();
      expect(onChange).toHaveBeenCalledOnce();
    },
  );

  it("retains incomplete numeric drafts locally and reports errors on blur without replacing the last valid value", () => {
    const onChange = vi.fn();
    const render = fieldHarness("steps", () => ({ values: { steps: 8 }, onChange }));
    render().input.props.onChange({ target: { value: "" } });
    expect(render().input.props.value).toBe("");
    expect(render().input.props["aria-invalid"]).toBe(false);
    render().input.props.onBlur();
    expect(render().input.props["aria-invalid"]).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    render().input.props.onChange({ target: { value: "201" } });
    expect(render().input.props.value).toBe("201");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("preserves decimal typing across its own acknowledgement but adopts external widget changes", () => {
    const values = { cfg: 12 };
    const onChange = vi.fn(patch => Object.assign(values, patch));
    const render = fieldHarness("cfg", () => ({ values, onChange }));
    render().input.props.onChange({ target: { value: "1." } });
    expect(values.cfg).toBe(1);
    expect(render().input.props.value).toBe("1.");
    render().input.props.onChange({ target: { value: "1.05" } });
    expect(values.cfg).toBe(1.05);
    expect(render().input.props.value).toBe("1.05");
    values.cfg = 2;
    expect(render().input.props.value).toBe("2");
  });

  it("does not submit changes through a disabled field", () => {
    const onChange = vi.fn();
    const render = fieldHarness("seed", () => ({ values: { seed: 8 }, disabled: true, onChange }));
    render().input.props.onChange({ target: { value: "25" } });
    render().input.props.onBlur();
    expect(onChange).not.toHaveBeenCalled();
  });
});
