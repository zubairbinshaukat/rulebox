import { SelectBase, type SelectProps, type SelectSearchProps } from "./Select";

export type SearchSelectProps = SelectProps & SelectSearchProps;

/**
 * `Select` with a search box in the popup, for long lists (groups, apps, employees).
 * The box is an ARIA combobox: type to filter (case and accents ignored), Arrow keys move through
 * the matches, Enter chooses, Escape clears the text first and closes on the second press.
 *
 * The list is filtered here unless `onSearch` is given: then the parent owns the filtering
 * (a server search, debounced by the parent), shows `loading`, and passes the new `options`.
 */
export function SearchSelect(props: SearchSelectProps) {
  return <SelectBase {...props} searchable />;
}
