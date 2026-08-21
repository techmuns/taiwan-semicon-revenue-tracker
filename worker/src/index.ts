/**
 * Taiwan semiconductor supply-chain monthly revenue tracker.
 *
 * Phase 3 stub: proves deployment, D1 connectivity, and the public URL.
 * The real API surface (/api/analytics, /api/heatmap, ...) lands after the
 * schema and backfill are in place.
 */

export interface Env {
  DB: D1Database;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return json(await health(env));
    }

    if (url.pathname === "/") {
      return new Response(
        "taiwan-semicon-revenue-tracker\n\nnot built yet - see /api/health\n",
        { headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }

    return json({ error: "not found", path: url.pathname }, 404);
  },
} satisfies ExportedHandler<Env>;

async function health(env: Env) {
  const out: Record<string, unknown> = {
    ok: true,
    service: "taiwan-semicon-revenue-tracker",
    phase: "3-stub",
  };

  // Confirm the D1 binding is actually wired up, without assuming any schema exists.
  try {
    const row = await env.DB.prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'",
    ).first<{ n: number }>();
    out.d1 = { bound: true, tables: row?.n ?? 0 };
  } catch (err) {
    out.d1 = { bound: false, error: err instanceof Error ? err.message : String(err) };
  }

  return out;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
