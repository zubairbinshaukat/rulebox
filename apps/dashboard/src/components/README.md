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
- View: `useViewMode()` / `<ViewSwitch />` (`lib/viewMode.ts`); `html[data-view]` is set by `src/boot/boot.js`. `stack={false}` forces the table. In cards view the toolbar shows a sort select.
- Row click ignores links, buttons, fields, dialogs and anything with `data-no-row-click`.
- `Modal` renders through a portal into `document.body`, so a dialog opened from the top bar or a table cell is never clipped by an ancestor.
