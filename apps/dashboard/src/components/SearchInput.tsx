import { useId } from "react";
import { Input } from "@rulebox/ui";
import IconSearch from "~icons/solar/magnifier-linear";
import IconClose from "~icons/solar/close-circle-linear";
import { strings } from "../lib/strings";

export function SearchInput({
  value,
  onChange,
  label,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder?: string;
}) {
  const id = useId();
  return (
    <div className="dash-search" role="search">
      <label htmlFor={id} className="dash-sr">
        {label}
      </label>
      <IconSearch className="dash-search__icon" aria-hidden="true" />
      <Input
        id={id}
        type="search"
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && value) {
            e.preventDefault();
            onChange("");
          }
        }}
      />
      {value ? (
        <button type="button" className="dash-icon-btn dash-search__clear" aria-label={strings.common.clearSearch} title={strings.common.clearSearch} onClick={() => onChange("")}>
          <IconClose aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
