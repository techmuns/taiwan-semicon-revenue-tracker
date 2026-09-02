/**
 * What is left of the API after Cloudflare D1.
 *
 * There were seven endpoints and 25 `env.DB` call sites. All of them are gone:
 * every answer the dashboard needs is a static file published by
 * `twrev export`, and the browser filters them (web/src/dataset.ts). The one
 * aggregation that genuinely needed a GROUP BY - the bucket heatmap - is
 * computed at publish time by the same SQL statement that ran on D1, out of
 * ingest/src/twrev/sql/heatmap_bucket.sql, and shipped as answers.
 *
 * Two things remain server-side, and both earn their place.
 *
 * /api/health, because a liveness check a reader's own browser can compute is
 * not a liveness check. It reads the PUBLISHED meta.json through the assets
 * binding - the same bytes a reader gets - and returns 503 when that file is
 * missing, unparseable or empty. That is the same rule the D1 version followed
 * ("a monitor that only reads the status code would otherwise see green on an
 * empty database"), and it is the reason this endpoint was not simply deleted:
 * during the D1 outage that prompted this migration, every data endpoint was
 * failing while /api/health reported ok:true, and nothing external could see it.
 *
 * The retired routes answer 410 rather than 404. A 404 says "wrong URL" and
 * invites a retry; 410 says the resource is deliberately gone and names its
 * replacement, which is what an old bookmark or a stale cached bundle needs.
 */

export interface Env {
  ASSETS?: Fetcher;
  DASHBOARD_KEY?: string;
  CF_ACCESS_AUD?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
}

export function json(body: unknown, status = 200, extra: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // The published files are immutable for a deploy, but this endpoint
      // reports freshness and must never be answered from a cache.
      "cache-control": "no-store",
      ...extra,
    },
  });
}

/** Every route that used to be answered out of D1, and where it went. */
const RETIRED: Record<string, string> = {
  "/api/meta": "/data/meta.json",
  "/api/analytics": "/data/analytics.json",
  "/api/heatmap": "/data/heatmap.json",
  "/api/quality": "/data/quality.json",
  "/api/company": "/data/company/<ticker>.json",
  "/api/export.csv": "/data/export.csv",
};

function retiredFor(path: string): string | undefined {
  if (RETIRED[path]) return RETIRED[path];
  if (path.startsWith("/api/company/")) return RETIRED["/api/company"];
  return undefined;
}

/**
 * Liveness, read from the same bytes a reader gets.
 *
 * Deliberately NOT computed from anything this Worker holds in memory: the
 * failure it exists to catch is a publish that did not happen or landed empty,
 * and only reading the artefact can see that.
 */
async function health(env: Env): Promise<Response> {
  const service = "taiwan-semicon-revenue-tracker";
  if (!env.ASSETS) {
    return json({ ok: false, service, error: "no assets binding" }, 503);
  }
  let meta: { months?: string[]; universe?: unknown[]; generated_at_utc?: string };
  try {
    const resp = await env.ASSETS.fetch(new Request("https://assets.local/data/meta.json"));
    if (!resp.ok) {
      return json({ ok: false, service, error: `meta.json: HTTP ${resp.status}` }, 503);
    }
    meta = await resp.json();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return json({ ok: false, service, error: `meta.json unreadable: ${detail}` }, 503);
  }

  const months = Array.isArray(meta.months) ? meta.months : [];
  const universe = Array.isArray(meta.universe) ? meta.universe : [];
  // An empty publish is a failure, not a quiet success. This is the whole
  // reason the endpoint reads the file rather than reporting its own uptime.
  if (!months.length || !universe.length) {
    return json(
      { ok: false, service, error: "published data is empty", months: months.length,
        universe_n: universe.length },
      503,
    );
  }
  return json({
    ok: true,
    service,
    data: {
      source: "/data/meta.json",
      universe_n: universe.length,
      months: months.length,
      latest_month: months[months.length - 1],
      generated_at_utc: meta.generated_at_utc ?? null,
    },
  });
}

export async function handleApi(_request: Request, env: Env, path: string): Promise<Response> {
  if (path === "/api/health") return health(env);

  const replacement = retiredFor(path);
  if (replacement) {
    return json(
      {
        error: "endpoint retired",
        detail:
          "This dashboard no longer queries a database. The data is published as " +
          "static files and filtered in the browser.",
        path,
        replacement,
      },
      410,
    );
  }
  return json({ error: "not found", path }, 404);
}
