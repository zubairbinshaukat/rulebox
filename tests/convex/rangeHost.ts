// A stub `fetch` that serves byte ranges like an installer host would (Phase 6 Step 13). No test uses the network: a test hands this to
// `inspectInstallerUrl` or installs it with `vi.stubGlobal("fetch", host.fetch)` for the `apps:inspectInstaller` action.

export type Route = {
  body: Uint8Array;
  /** false = the host ignores `Range` and answers 200 with the whole file. Default true. */
  ranges?: boolean;
  /** The `Content-Length` of a 200 answer when it is not the body's length (so a huge file needs no huge body). */
  declaredLength?: number;
  /** Answer a redirect to this address instead. */
  redirect?: string;
  /** Answer this status with an empty body instead. */
  status?: number;
  /** A `Content-Range` total other than the body's length. */
  total?: number | "*";
};

export type Call = { url: string; range: string | null };

export function rangeHost(routes: Record<string, Route>): { fetch: typeof fetch; calls: Call[]; bytesServed: () => number } {
  const calls: Call[] = [];
  let served = 0;
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const range = new Headers(init?.headers).get("range");
    calls.push({ url, range });
    const r = routes[url];
    if (r === undefined) return new Response("nope", { status: 404 });
    if (r.redirect !== undefined) return new Response(null, { status: 302, headers: { location: r.redirect } });
    if (r.status !== undefined) return new Response(null, { status: r.status });
    const body = r.body;
    const m = range === null ? null : /^bytes=(\d+)-(\d+)$/.exec(range);
    if (r.ranges === false || m === null) {
      served += body.length;
      return new Response(body as BodyInit, { status: 200, headers: { "content-length": String(r.declaredLength ?? body.length) } });
    }
    const from = Number(m[1]);
    const to = Math.min(Number(m[2]), body.length - 1);
    if (from >= body.length) return new Response(null, { status: 416 });
    const part = body.slice(from, to + 1);
    served += part.length;
    return new Response(part as BodyInit, { status: 206, headers: { "content-range": `bytes ${from}-${to}/${r.total ?? body.length}`, "content-length": String(part.length) } });
  }) as typeof fetch;
  return { fetch: f, calls, bytesServed: () => served };
}
