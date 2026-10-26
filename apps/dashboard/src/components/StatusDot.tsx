export type StatusTone = "success" | "warning" | "danger" | "neutral";

/** Status is never colour alone: a dot (shape differs for neutral) plus a word. */
export function StatusDot({ tone, label, sub, title }: { tone: StatusTone; label: string; sub?: string; title?: string }) {
  return (
    <span className={`dash-status dash-status--${tone}`} title={title}>
      <span className="dash-status__dot" aria-hidden="true" />
      <span className="dash-status__body">
        <span className="dash-status__text">{label}</span>
        {sub ? <span className="dash-status__sub">{sub}</span> : null}
      </span>
    </span>
  );
}
