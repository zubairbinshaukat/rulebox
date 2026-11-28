# Lists: DataTable, Pager, SearchInput, view switch

One table for every list (Phase 4b). The server does the sorting, searching and paging; these parts only draw it and report what the person did.

## Wiring a server-driven list

```tsx
const [sort, setSort] = useState<SortState>({ key: "name", dir: "asc" });
const [search, setSearch] = useState("");          // applied search text (Enter), keep it in the URL
const [pageSize, setPageSize] = useState(25);      // 10 | 25 | 50 (PAGE_SIZES)
const total = useDevicesCount();                   // number | null (no counter: null)

const pager = useCursorPager({ pageSize, total, resetKey: `${sort.key}:${sort.dir}|${search}|${groupId}` });
const req = pager.request(sort.dir);               // { dir, numItems, cursor, reverse }
const list = useDevicesPage({ sort: sort.key, dir: req.dir, numItems: req.numItems, cursor: req.cursor, search }); // your hook
const rows = req.reverse ? [...list.items].reverse() : list.items;   // last page is read in the opposite order

<DataTable
  framed                                           // own card; leave off while a screen still wraps it in <Card body="none">
  caption="Devices" columns={cols} rows={rows} getKey={(r) => r._id}
  sort={sort} onSortChange={setSort}               // only columns with `sortable: true` (key = server sort key)
  onRowClick={(r) => navigate(`/devices/${r._id}`)}// keep a <Link> in the name cell
  state={list.status === "loading" ? "loading" : list.status === "error" ? "error" : rows.length === 0 ? "empty" : "ready"}
  busy={list.isLoadingMore} empty={<EmptyState .../>} error={list.error} onRetry={list.retry}
  toolbar={<><SearchInput label="Search devices" value={search} onSearch={setSearch} />{filters}</>}
  footer={<Pager page={pager.page} pageSize={pageSize} total={total} hasNext={!list.isDone}
           reachablePages={pager.reachablePages(!list.isDone)}
           onPage={(n) => pager.go(n, list.continueCursor)} onPageSize={setPageSize} loading={list.isLoadingMore} />}
/>
```

- `pager.go(n, continueCursor)`: pass the current page's `continueCursor` so page + 1 can open. Visited pages and (with a total) the last page need no cursor. From a last-page jump, only visited pages and page 1 are reachable backwards.
- Changing `pageSize` or `resetKey` starts over on page 1 (never send an old cursor with new arguments).
- Pure helpers (`goToPage`, `pageRequest`, `lastPageRequest`, `reachablePages`) are in `lib/cursorPager.ts`; the hook never calls Convex.
- Sticky header: the table scrolls sideways, so the header sticks only inside its own scroll box. Pass `maxHeight="70vh"` if a list needs it.

## Details

- `SearchInput`: `onSearch(text)` fires on Enter, the clear button and Escape (clear). `live` restores the 250 ms debounce. The old `value` + `onChange` props still work until a screen is migrated.
- View: `useViewMode()` / `<ViewSwitch />` (`lib/viewMode.ts`); `html[data-view]` is set by `src/boot/boot.js`. A stored choice wins; with none, a viewport under 600 px shows cards and follows the width live. Printing always prints the table. `stack={false}` forces the table (no switch).

## Columns: type, card roles, actions (`DataTable.tsx`, `lib/cardLayout.ts`)

One `Column` definition draws both views. Say what a column *is* and the table and the cards follow.

- `type`: `name` | `text` | `short` | `date` | `num` | `badge` | `mono` | `actions` (class `dash-col--<type>` on `th` and `td`). `name` one line cut at `maxWidth` (default 280), `text` two lines (360), `mono` one line (200), `badge` pills that wrap between pills (280), the rest never wrap. Default: `primary` is `name`, `actions` is `actions`, `numeric` is `num`, `nowrap` is `short`, anything else still wraps (until its screen declares a type). `maxWidth` is the px cap of the inner box (a `max-width` on a `td` does nothing in auto table layout).
- Cut text: a plain string in a `name`/`text`/`mono` cell gets `Truncate` for free. For links, pills and sub-lines wrap the visible text yourself: `<Truncate lines={1|2|3} full="...">...</Truncate>` (one shared tooltip on hover after 400 ms and on focus; cut plain text becomes a tab stop; never add `title`). `DataTable` itself uses `TruncateLazy` (same markup at once, the measuring and tooltip download a moment later); a screen that imports `Truncate` directly adds about 1 KB gzip to its own chunk, so prefer `TruncateLazy` for cells in the first screens (Overview).
- Lazy parts (first signed-in page size): the Cards view (`CardGrid`, `SkeletonCards`, the sort `Select`, `cardLayout`) loads only when the resolved view is cards (`cardsLazy.ts`; the Cards switch preloads on hover and focus), the row "More actions" menu loads for a row with more than two actions, and the rows-per-page `Select` loads when the full pager is drawn. The table path imports none of them. A test of a cards list must `await screen.findBy...`.
- Cards: `card` is `title` | `subtitle` | `status` | `fact` | `detail` | `actions` | `hidden`. Default: `primary` is the title, `actions` the footer, everything else a fact (at most 4 facts, extras become details). `cardCell` is the card's own rendering, `cardSub` the title column's subtitle, `cardLabel` the label (`false` = value only), `cardWide` a fact over the full row, `table: false` a card-only column. A list shown as cards needs a title column. Technical values (builds, versions, exit codes) are details or hidden, never facts.
- Actions: `rowActions: (row) => RowAction[]` on the `actions` column (with `rowLabel` on the table). Two or fewer are buttons, more: the `primary` one plus a "More actions" menu (destructive last). Same code in the table cell and the card footer.
- Toolbar: `toolbar` (search, filters), `toolbarEnd` (list-wide actions), `defaultSort={{ key, dir, label }}` for a server order that has no column ("Newest first"), `pageKey` (the page number: the list scrolls back into view when it changes and top is hidden). `ServerTable` passes all of these.
- Row click ignores links, buttons, fields, dialogs and anything with `data-no-row-click`.
- `Modal` renders through a portal into `document.body`, so a dialog opened from the top bar or a table cell is never clipped by an ancestor.
