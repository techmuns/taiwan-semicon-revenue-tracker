/**
 * Worker entrypoint: router, access gate, static assets.
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
    // figures, and every data request it then makes goes through the gate below.
    //
    // /data/ IS EXCLUDED HERE, and that exclusion is load-bearing. Those files
    // are the figures. wrangler.toml routes them through this Worker
    // (`run_worker_first`) precisely so the gate applies; letting the SPA
    // branch answer them would serve index.html for a JSON request, and
    // letting the asset server answer them would skip the credential check
    // altogether - which is what /api/* never allowed.
    if (
      env.ASSETS &&
      !path.startsWith("/api/") &&
      !path.startsWith("/data/") &&
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

    // The published data, now that the gate has passed. Served from the assets
    // binding rather than proxied to an origin: same bytes, one hop.
    if (path.startsWith("/data/")) {
      if (!env.ASSETS) return json({ error: "no assets binding", path }, 503);
      return env.ASSETS.fetch(request);
    }

    if (path.startsWith("/api/")) {
      try {
        return await handleApi(request, env, path);
      } catch (err) {
        // Never an opaque 1101: the message names the surface that failed so a
        // broken publish is diagnosable from the response alone.
        const message = err instanceof Error ? err.message : String(err);
        console.error(`api error path=${path}: ${message}`);
        return json({ error: "request failed", path, detail: message }, 500);
      }
    }

    // Only reachable when the dashboard has not been built into public/, so
    // env.ASSETS is undefined and the SPA branch above did not fire.
    return new Response(landing(env), {
      status: path === "/" ? 200 : 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },

  // NO `scheduled` HANDLER. It went with Cloudflare D1.
  //
  // It could never have run anyway: the account sits at the Workers Free
  // ceiling of five cron triggers PER ACCOUNT, so `wrangler deploy` reported
  // code: 10072 and the handler was never registered - not once. That is why
  // the refresh moved to GitHub Actions, which is where it still runs and the
  // only place it should.
  //
  // With D1 gone it could not work even if a slot were freed: the refresh
  // builds a SQLite file and publishes JSON, neither of which a Worker can do.
  // Deleting it drops 866 lines of cron.ts that never executed in production
  // and that a reader would reasonably have assumed were live.
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
    "",
    "  The data is published as static files, not queried from a database:",
    "  GET /data/meta.json",
    "  GET /data/analytics.json",
    "  GET /data/heatmap.json",
    "  GET /data/quality.json",
    "  GET /data/company/2330.json",
    "  GET /data/export.csv",
    "",
    "  The former /api/* data routes answer 410 with their replacement.",
    "",
    `access mode: ${mode}${mode === "open" ? "  <-- NO ACCESS CONTROL" : ""}`,
    "",
  ].join("\n");
}
