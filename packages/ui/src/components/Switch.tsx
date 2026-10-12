export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  disabled?: boolean;
}

/** On/off toggle with an optional label. */
export function Switch({ checked, onChange, label, disabled }: SwitchProps) {
  return (
    <label className="rb-switch" data-disabled={disabled || undefined}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        className="rb-switch__track"
        onClick={() => onChange(!checked)}
      >
        <span className="rb-switch__thumb" />
      </button>
      {label && <span>{label}</span>}
    </label>
  );
}
