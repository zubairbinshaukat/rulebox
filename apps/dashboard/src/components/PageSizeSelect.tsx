import { Select } from "@rulebox/ui";

export interface PageSizeSelectProps {
  id: string;
  value: number;
  sizes: readonly number[];
  onChange: (size: number) => void;
}

/**
 * The "Rows per page" dropdown. A module of its own: `Pager` loads it with `React.lazy` only when it draws
 * the full bar (more than one page, or a size other than the default), so the custom `Select` and its
 * floating placement are not part of every list page's first load.
 */
export function PageSizeSelect({ id, value, sizes, onChange }: PageSizeSelectProps) {
  return <Select id={id} compact value={String(value)} options={sizes.map((s) => ({ value: String(s), label: String(s) }))} onChange={(v) => onChange(Number(v))} />;
}
