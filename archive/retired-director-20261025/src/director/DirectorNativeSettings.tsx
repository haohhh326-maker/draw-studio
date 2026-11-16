import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  directorNativeChoices,
  directorNativeSettingDisabled,
  directorNativeSettingPatch,
  directorNativeSettings,
  type DirectorNativeOptions,
  type DirectorNativeSetting,
} from "./native-settings";

export type DirectorNativeSettingsProps = DirectorNativeOptions & {
  values: Record<string, unknown>;
  onChange(patch: Record<string, unknown>): void;
  disabled?: boolean;
};

const controlStyle: CSSProperties = {
  width: "100%",
  minWidth: 0,
  boxSizing: "border-box",
  background: "#181818",
  border: "1px solid #454545",
  borderRadius: 4,
  padding: "5px 7px",
  color: "#ddd",
  fontSize: 11,
  height: 29,
};
const fieldStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: 11,
  color: "#bbb",
  minWidth: 0,
};

function SettingField({
  field,
  values,
  onChange,
  disabled,
  ...options
}: DirectorNativeSettingsProps & { field: DirectorNativeSetting }) {
  const value = values[field.key] ?? field.defaultValue;
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState("");
  const pendingValue = useRef<unknown>(undefined);
  useEffect(() => {
    // Keep the user's spelling/caret while the host acknowledges this edit.
    // In particular, a valid intermediate decimal such as "1." must stay editable.
    if (Object.is(value, pendingValue.current)) {
      pendingValue.current = undefined;
      return;
    }
    pendingValue.current = undefined;
    setDraft(String(value));
    setError("");
  }, [value]);
  const reason = directorNativeSettingDisabled(field, options),
    unavailable = disabled || !!reason;
  const apply = (raw: unknown, reportInvalid = true) => {
    if (unavailable) return;
    try {
      const patch = directorNativeSettingPatch(field.key, raw, values, options);
      setError("");
      if (patch[field.key] !== value) {
        pendingValue.current = patch[field.key];
        onChange(patch);
      }
    } catch (reason) {
      if (reportInvalid) setError(reason instanceof Error ? reason.message : "参数无效。");
    }
  };
  const label = `导演台${field.label}`;
  if (field.kind === "boolean")
    return (
      <label
        style={{
          ...fieldStyle,
          flexDirection: "row",
          alignItems: "center",
          minHeight: 29,
        }}
        title={field.help}
      >
        <input
          aria-label={label}
          type="checkbox"
          checked={Boolean(value)}
          disabled={unavailable}
          onChange={(event) => apply(event.target.checked)}
          style={{ margin: 0, accentColor: "#3bf586", width: 13, height: 13 }}
        />
        <span>{field.label}</span>
      </label>
    );
  return (
    <label style={fieldStyle} title={reason || field.help}>
      <span>{field.label}</span>
      {field.kind === "select" ? (
        <select
          aria-label={label}
          value={String(value)}
          disabled={unavailable}
          onChange={(event) => apply(event.target.value)}
          style={controlStyle}
        >
          {directorNativeChoices(field, value, options).map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </select>
      ) : (
        <input
          aria-label={label}
          type="text"
          inputMode={
            field.kind === "number"
              ? field.integer
                ? "numeric"
                : "decimal"
              : "text"
          }
          value={draft}
          disabled={unavailable}
          aria-invalid={!!error}
          onChange={(event) => {
            setDraft(event.target.value);
            setError("");
            // Ctrl+S and the run action read the host, even while this input is focused.
            apply(event.target.value, false);
          }}
          onBlur={() => apply(draft)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setDraft(String(value));
              setError("");
            }
          }}
          style={controlStyle}
        />
      )}
      {error && (
        <span role="alert" style={{ color: "#ffb2a6", fontSize: 10 }}>
          {error}
        </span>
      )}
    </label>
  );
}

/** Real ComfyUI widgets that were formerly absent from the DOM-only editor host. */
export function DirectorNativeSettings(props: DirectorNativeSettingsProps) {
  const fields = directorNativeSettings(props);
  return (
    <details
      className="director-native-settings"
      style={{
        background: "#292929",
        border: "1px solid #424242",
        borderRadius: 5,
        margin: "6px 0",
        color: "#ddd",
      }}
    >
      <summary
        style={{
          cursor: "pointer",
          padding: "7px 10px",
          fontSize: 11,
          userSelect: "none",
        }}
      >
        采样与性能
      </summary>
      <div style={{ display: "grid", gap: 10, padding: "2px 10px 10px" }}>
        {(
          [
            ["sample", "采样设置"],
            ["advanced", "高级采样"],
            ["performance", "性能与缓存"],
          ] as const
        ).map(([group, label]) => (
          <fieldset
            key={group}
            disabled={props.disabled}
            style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}
          >
            <legend style={{ padding: "0 0 6px", color: "#999", fontSize: 10 }}>
              {label}
            </legend>
            <div
              style={{
                display: "grid",
                gridTemplateColumns:
                  group === "sample"
                    ? "minmax(160px, 2fr) minmax(80px, 1fr)"
                    : "repeat(auto-fit, minmax(125px, 1fr))",
                gap: "7px 9px",
                alignItems: "end",
              }}
            >
              {fields
                .filter((field) => field.group === group)
                .map((field) => (
                  <SettingField key={field.key} {...props} field={field} />
                ))}
            </div>
          </fieldset>
        ))}
      </div>
    </details>
  );
}
