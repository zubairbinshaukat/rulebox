import { useId, type ReactNode } from "react";
import { NativeSelect } from "@rulebox/ui";
import IconPrev from "~icons/solar/alt-arrow-left-linear";
import IconNext from "~icons/solar/alt-arrow-right-linear";
import { PAGE_SIZES, pageItems } from "../lib/cursorPager";
import { strings } from "../lib/strings";

export interface PagerLabels {
  nav: string;
  previous: string;
  next: string;
  rowsPerPage: string;
  gap: string;
  goTo: (page: number) => string;
  summary: (page: number, pages: number | null, total: number | null) => ReactNode;
}

const DEFAULT_LABELS: PagerLabels = {
  nav: strings.pager.nav,
  previous: strings.pager.previous,
  next: strings.pager.next,
  rowsPerPage: strings.pager.rowsPerPage,
  gap: strings.pager.gap,
  goTo: strings.pager.goTo,
  summary: (page, pages, total) =>
    total !== null && pages !== null
      ? `${strings.pager.records(total)} · ${strings.pager.pageOf(page, pages)}`
      : strings.pager.page(page),
};

export interface PagerProps {
  /** 1-based. */
  page: number;
  pageSize: number;
  /** Null when the table has no counter: "Page N" only, no last page. */
  total: number | null;
  /** Pages that can be opened: visited ones, the next one, the last one when `total` is known. */
  reachablePages: ReadonlySet<number>;
  onPage: (page: number) => void;
  onPageSize: (size: number) => void;
  /** The server has more rows after this page. */
  hasNext: boolean;
  /** The page is loading: the strip stays, assistive tech hears it is busy. */
  loading?: boolean;
  pageSizes?: readonly number[];
  labels?: Partial<PagerLabels>;
}

/**
 * The bar under a table: "147 records · Page 1 of 15", `‹ 1 2 … 15 ›` and the rows-per-page select.
 * One row when the footer is at least 680 px wide (summary left, pages centred, select right), otherwise
 * the pages on top and the summary and select under them (see `.dash-pager` in dashboard.css).
 * Only pages that can really be opened are buttons.
 * Presentation only: `useCursorPager` (lib/cursorPager.ts) keeps the cursors.
 */
export function Pager({ page, pageSize, total, reachablePages, onPage, onPageSize, hasNext, loading = false, pageSizes = PAGE_SIZES, labels }: PagerProps) {
  const l = { ...DEFAULT_LABELS, ...labels };
  const selectId = useId();
  const pages = total === null ? null : Math.max(1, Math.ceil(total / pageSize));
  const items = pageItems(page, reachablePages, pages);
  const canPrev = page > 1 && reachablePages.has(page - 1);
  const canNext = (pages === null || page < pages) && (hasNext || reachablePages.has(page + 1));
  // A page size outside the list (a stale URL) is still shown, not silently replaced.
  const sizes = pageSizes.includes(pageSize) ? pageSizes : [...pageSizes, pageSize].sort((a, b) => a - b);

  return (
    <div className="dash-pager" data-loading={loading || undefined}>
      <p className="dash-pager__summary" role="status" aria-live="polite">
        {l.summary(page, pages, total)}
      </p>
      <nav className="dash-pager__nav" aria-label={l.nav} aria-busy={loading || undefined}>
        <button type="button" className="dash-pager__btn dash-pager__btn--arrow" aria-label={l.previous} title={l.previous} disabled={!canPrev} onClick={() => onPage(page - 1)}>
          <IconPrev aria-hidden="true" />
        </button>
        <ol className="dash-pager__pages">
          {items.map((it, i) =>
            it === "gap" ? (
              <li key={`gap-${i}`} className="dash-pager__gap" aria-hidden="true" title={l.gap}>
                …
              </li>
            ) : (
              <li key={it}>
                <button
                  type="button"
                  className="dash-pager__btn dash-pager__num"
                  aria-label={l.goTo(it)}
                  aria-current={it === page ? "page" : undefined}
                  onClick={() => (it === page ? undefined : onPage(it))}
                >
                  {it}
                </button>
              </li>
            ),
          )}
        </ol>
        <button type="button" className="dash-pager__btn dash-pager__btn--arrow" aria-label={l.next} title={l.next} disabled={!canNext} onClick={() => onPage(page + 1)}>
          <IconNext aria-hidden="true" />
        </button>
      </nav>
      <div className="dash-pager__size">
        <label htmlFor={selectId} className="dash-pager__size-label">
          {l.rowsPerPage}
        </label>
        <NativeSelect id={selectId} compact value={String(pageSize)} onChange={(e) => onPageSize(Number(e.target.value))}>
          {sizes.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </NativeSelect>
      </div>
    </div>
  );
}
