/**
 * Access control, with the mode DERIVED FROM CONFIG rather than hardcoded.
 *
 * Three modes, resolved from secrets at request time:
 *
 *   "open"      no secrets set. Everything is public.
 *   "secret"    DASHBOARD_KEY is set. A shared key, exchanged at POST /auth for
 *               an HttpOnly cookie.
 *   "cf-access" CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD are set. Cloudflare Access
 *               sits in front and the Worker independently verifies the JWT it
 *               stamps, so a request that bypasses the edge policy is still
 *               rejected.
 *
 * Why derive it instead of picking one:
 *
 * Cloudflare Access cannot protect a `*.workers.dev` hostname - it needs a zone.
 * So "put Access on it" is only available once a domain is onboarded, and until
 * then the shared key is the only mechanism that works on the deployed URL.
 * Deriving the mode means whichever is chosen is a `wrangler secret put`, not a
 * code change, and both are already implemented.
 *
 * The mode is REPORTED BY /api/meta. That is deliberate: "we left auth off and
 * forgot" is the failure this design is built to prevent, so the running service
 * states its own posture rather than leaving it to memory.
 *
 * The key is never accepted from a query string - it would land in browser
 * history, in any intermediary's logs, and in Cloudflare's own request logs.
 * POST /auth exchanges it for a cookie exactly once.
 */

export interface AccessEnv {
  DASHBOARD_KEY?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
}

export type AccessMode = "open" | "secret" | "cf-access";

export interface AccessResult {
  ok: boolean;
  mode: AccessMode;
  /** Present when known: the Access identity, for the audit line in the UI. */
  identity?: string;
  /** Why it was rejected. Deliberately vague to the client, specific in logs. */
  reason?: string;
}

const COOKIE_NAME = "twrev_session";

export function accessMode(env: AccessEnv): AccessMode {
  if (env.CF_ACCESS_TEAM_DOMAIN && env.CF_ACCESS_AUD) return "cf-access";
  if (env.DASHBOARD_KEY) return "secret";
  return "open";
}

/** Human-readable posture for /api/meta. Never includes the secret itself. */
export function accessPosture(env: AccessEnv): Record<string, unknown> {
  const mode = accessMode(env);
  return {
    mode,
    public: mode === "open",
    note:
      mode === "open"
        ? "NO ACCESS CONTROL. Set DASHBOARD_KEY, or CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD."
        : mode === "secret"
          ? "shared key via HttpOnly cookie; exchange at POST /auth"
          : "Cloudflare Access JWT, verified against the team JWKS",
  };
}

export async function checkAccess(request: Request, env: AccessEnv): Promise<AccessResult> {
  const mode = accessMode(env);
  if (mode === "open") return { ok: true, mode };
  if (mode === "secret") return checkSharedKey(request, env);
  return checkCfAccess(request, env);
}

// ------------------------------------------------------------- shared key --

function checkSharedKey(request: Request, env: AccessEnv): AccessResult {
  const key = env.DASHBOARD_KEY!;
  const presented =
    readCookie(request, COOKIE_NAME) ?? request.headers.get("x-dashboard-key");
  if (!presented) return { ok: false, mode: "secret", reason: "no credential presented" };
  if (!timingSafeEqual(presented, key)) {
    return { ok: false, mode: "secret", reason: "key mismatch" };
  }
  return { ok: true, mode: "secret", identity: "shared-key" };
}

/**
 * POST /auth with {key} - sets the session cookie.
 *
 * Rate limiting is deliberately NOT implemented here: a single high-entropy key
 * is not guessable at HTTP rates, and a counter in D1 would add a write to every
 * failed request. If this ever becomes a multi-user login, that changes.
 */
export async function handleAuth(request: Request, env: AccessEnv): Promise<Response> {
  if (accessMode(env) !== "secret") {
    return new Response(JSON.stringify({ error: "shared-key auth is not enabled" }), {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST required" }), {
      status: 405,
      headers: { "content-type": "application/json; charset=utf-8", allow: "POST" },
    });
  }

  let presented = "";
  const contentType = request.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("application/json")) {
      presented = String(((await request.json()) as { key?: unknown }).key ?? "");
    } else {
      presented = String((await request.formData()).get("key") ?? "");
    }
  } catch {
    presented = "";
  }

  if (!timingSafeEqual(presented, env.DASHBOARD_KEY!)) {
    // No distinction between "empty" and "wrong" - it tells an attacker nothing.
    return new Response(JSON.stringify({ ok: false, error: "invalid key" }), {
      status: 401,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  const cookie = [
    `${COOKIE_NAME}=${encodeURIComponent(env.DASHBOARD_KEY!)}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    `Max-Age=${60 * 60 * 24 * 30}`,
  ].join("; ");

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "set-cookie": cookie },
  });
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

// ------------------------------------------------------- Cloudflare Access --

interface Jwk {
  kid: string;
  kty: string;
  alg?: string;
  n: string;
  e: string;
}

// Module-scope cache. Workers isolates are short-lived, so this is a best-effort
// cache that saves a JWKS fetch on warm requests, not a correctness dependency.
let jwksCache: { url: string; keys: Jwk[]; fetchedAt: number } | null = null;
const JWKS_TTL_MS = 10 * 60 * 1000;

async function checkCfAccess(request: Request, env: AccessEnv): Promise<AccessResult> {
  const token =
    request.headers.get("cf-access-jwt-assertion") ?? readCookie(request, "CF_Authorization");
  if (!token) {
    return { ok: false, mode: "cf-access", reason: "no Cf-Access-Jwt-Assertion" };
  }

  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, mode: "cf-access", reason: "malformed JWT" };

  let header: { kid?: string; alg?: string };
  let payload: { aud?: unknown; iss?: string; exp?: number; nbf?: number; email?: string };
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
  } catch {
    return { ok: false, mode: "cf-access", reason: "undecodable JWT" };
  }

  if (header.alg !== "RS256") {
    // Refusing anything else is what blocks the alg=none / HS256-confusion class
    // of attack, where a forged token is signed with the public key as an HMAC.
    return { ok: false, mode: "cf-access", reason: `unexpected alg ${header.alg}` };
  }

  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN!.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const jwksUrl = `https://${teamDomain}/cdn-cgi/access/certs`;
  const keys = await fetchJwks(jwksUrl);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return { ok: false, mode: "cf-access", reason: "unknown kid" };

  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const verified = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlToBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!verified) return { ok: false, mode: "cf-access", reason: "bad signature" };

  // A valid signature is not enough. Without the aud check, a token minted for
  // ANY application in the same Access team would be accepted here.
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.CF_ACCESS_AUD!)) {
    return { ok: false, mode: "cf-access", reason: "aud mismatch" };
  }
  if (payload.iss && !payload.iss.includes(teamDomain)) {
    return { ok: false, mode: "cf-access", reason: "iss mismatch" };
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === "number" && payload.exp < now) {
    return { ok: false, mode: "cf-access", reason: "expired" };
  }
  if (typeof payload.nbf === "number" && payload.nbf > now + 60) {
    return { ok: false, mode: "cf-access", reason: "not yet valid" };
  }

  return { ok: true, mode: "cf-access", identity: payload.email ?? "access-user" };
}

async function fetchJwks(url: string): Promise<Jwk[]> {
  if (jwksCache && jwksCache.url === url && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  const resp = await fetch(url, { headers: { accept: "application/json" } });
  if (!resp.ok) throw new Error(`JWKS fetch failed: HTTP ${resp.status}`);
  const body = (await resp.json()) as { keys?: Jwk[] };
  const keys = body.keys ?? [];
  jwksCache = { url, keys, fetchedAt: Date.now() };
  return keys;
}

// ------------------------------------------------------------------ helpers --

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

/**
 * Constant-time-ish comparison.
 *
 * Length is compared first, which does leak the length - unavoidable without
 * hashing, and not useful against a random key. What matters is that a matching
 * PREFIX takes the same time as a non-matching one, so the key cannot be
 * recovered character by character.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function b64urlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
