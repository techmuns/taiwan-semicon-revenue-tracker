/**
 * Worker entrypoint: router, access gate, cron hook.
 *
 * Route order is the contract:
 *
 *   1. /api/health  - ALWAYS open. A monitor must be able to see "up" without a
 *                     credential, and the response carries no revenue figures.
 *   2. /auth        - open by construction; it is how a credential is obtained.
 *   3. everything   - behind checkAccess().
 *
 * The gate is applied ONCE here rather than per-handler. A per-handler check is
 * the shape where a route added later is silently public.
 */

import { checkAccess, clearSessionCookie, handleAuth, accessMode } from "./access";
import { handleApi, json, type Env } from "./api";
import { runRefresh } from "./cron";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") return preflight();

    // Open routes, in the order given above.
    if (path === "/api/health") return handleApi(request, env, "/api/health");
    if (path === "/auth") return handleAuth(request, env);
    if (path === "/logout") {
      return new Response(JSON.stringify({ ok: true }), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "set-cookie": clearSessionCookie(),
        },
      });
    }

    // The SPA shell.
    //
    // Assets are served by the asset server *before* the Worker runs, so any
    // non-/api path that gets here matched no file on disk: it is a client-side
    // route (`/?tab=company&ticker=2330` deep link, or a stale bookmark). Serve
    // index.html and let the router resolve it.
    //
    // This sits ahead of the access gate on purpose. `/` is already served
    // without a credential by the asset server, so gating a deep link would
    // break bookmarks without protecting anything - the shell contains no
    // figures, and every /api/* call it then makes goes through the gate below.
    if (
      env.ASSETS &&
      !path.startsWith("/api/") &&
      (request.method === "GET" || request.method === "HEAD")
    ) {
      return env.ASSETS.fetch(new Request(new URL("/index.html", url), request));
    }

    const access = await checkAccess(request, env);
    if (!access.ok) {
      // The reason goes to the log, not to the client - "aud mismatch" vs "bad
      // signature" tells an attacker which half of the token to fix.
      console.log(`access denied: mode=${access.mode} reason=${access.reason} path=${path}`);
      return unauthorized(access.mode, path);
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return json({ error: "read-only API", method: request.method }, 405);
    }

    if (path.startsWith("/api/")) {
      try {
        return await handleApi(request, env, path);
      } catch (err) {
        // A D1 error must not become an opaque 1101. The message names the query
        // surface so a schema change is diagnosable from the response alone.
        const message = err instanceof Error ? err.message : String(err);
        console.error(`api error path=${path}: ${message}`);
        return json({ error: "query failed", path, detail: message }, 500);
      }
    }

    // Only reachable when the dashboard has not been built into public/, so
    // env.ASSETS is undefined and the SPA branch above did not fire.
    return new Response(landing(env), {
      status: path === "/" ? 200 : 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },

  /**
   * Monthly refresh.
   *
   * AWAITED, not ctx.waitUntil'd. There is no client waiting on a cron, so
   * backgrounding buys nothing and costs the two things that matter: the
   * runtime's own success/failure accounting (which is what the dashboard's cron
   * history shows) and the guarantee that the work finishes before the
   * invocation ends. A silent cron is the failure mode that takes a month to
   * notice, so the error is logged with the expression that produced it and then
   * re-thrown to mark the invocation failed.
   */
  async scheduled(event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    try {
      await runRefresh(env, event.cron);
    } catch (err) {
      console.error(`cron ${event.cron} failed: ${err instanceof Error ? err.stack : err}`);
      throw err;
    }
  },
} satisfies ExportedHandler<Env>;

// ------------------------------------------------------------------ helpers --

function unauthorized(mode: string, path: string): Response {
  const body = {
    error: "unauthorized",
    mode,
    path,
    hint:
      mode === "secret"
        ? "POST /auth with {\"key\":\"...\"}, or send an X-Dashboard-Key header"
        : "reach this Worker through Cloudflare Access",
  };
  return new Response(JSON.stringify(body, null, 2), {
    status: 401,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      // Not WWW-Authenticate: Basic - that triggers the browser's native prompt,
      // which cannot be styled and offers no way out but closing the tab.
      "x-access-mode": mode,
    },
  });
}

/** No CORS by default: the dashboard is served from this same origin. */
function preflight(): Response {
  return new Response(null, {
    status: 204,
    headers: { allow: "GET, HEAD, POST, OPTIONS", "cache-control": "no-store" },
  });
}

function landing(env: Env): string {
  const mode = accessMode(env);
  return [
    "taiwan-semicon-revenue-tracker",
    "",
    "The dashboard assets are not deployed yet. The API is live:",
    "",
    "  GET /api/health          (always open)",
    "  GET /api/meta",
    "  GET /api/analytics?from=2026-01&to=2026-07",
    "  GET /api/heatmap?metric=yoy_acceleration_ppt&group=bucket",
    "  GET /api/company/2330",
    "  GET /api/quality",
    "  GET /api/export.csv",
    "",
    `access mode: ${mode}${mode === "open" ? "  <-- NO ACCESS CONTROL" : ""}`,
    "",
  ].join("\n");
}
