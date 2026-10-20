import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import { splitBaseAndExt, validateName } from "./validation";

export interface RenameInputProps {
  initialName: string;
  /** Centered text, for the grid view. */
  centered?: boolean;
  onCommit: (name: string) => void;
  onCancel: () => void;
}

/**
 * Inline rename. The base name is selected, not the extension. Enter or
 * leaving the field applies a valid, changed name; Escape cancels. The rule a
 * bad name breaks is named under the field.
 */
export function RenameInput({ initialName, centered = false, onCommit, onCancel }: RenameInputProps) {
  const [name, setName] = useState(initialName);
  const inputRef = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  const validation = validateName(name);

  useEffect(() => {
    const input = inputRef.current;
    if (input) {
      input.focus();
      input.setSelectionRange(0, splitBaseAndExt(initialName).base.length);
    }
  }, [initialName]);

  function finish(commit: boolean) {
    if (finished.current) {
      return;
    }
    finished.current = true;
    if (commit && validation.valid && name !== initialName) {
      onCommit(name);
    } else {
      onCancel();
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    // An invalid name keeps the field open so the message stays readable.
    if (validation.valid) {
      finish(true);
    }
  }

  function onKeyDown(event: KeyboardEvent) {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      finish(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      style={{ position: "relative", flex: 1, minWidth: 0, width: centered ? "100%" : undefined }}
    >
      <input
        ref={inputRef}
        className="rb-input"
        aria-label="New name"
        aria-invalid={!validation.valid}
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => finish(true)}
        style={{
          width: "100%",
          height: centered ? 26 : 28,
          fontSize: centered ? 12 : 13,
          textAlign: centered ? "center" : "left",
          padding: "2px 6px",
          border: `1px solid ${validation.valid ? "var(--rb-accent)" : "var(--rb-danger)"}`,
        }}
      />
      {!validation.valid && validation.message ? (
        <span
          role="alert"
          style={{
            position: "absolute",
            top: "100%",
            left: centered ? "50%" : 0,
            transform: centered ? "translateX(-50%)" : undefined,
            marginTop: 4,
            padding: "3px 6px",
            background: "var(--rb-surface)",
            border: "1px solid var(--rb-danger)",
            borderRadius: 6,
            color: "var(--rb-danger-text)",
            fontSize: 11,
            zIndex: 10,
            whiteSpace: "nowrap",
            boxShadow: "var(--rb-shadow-sm)",
          }}
        >
          {validation.message}
        </span>
      ) : null}
    </form>
  );
}
