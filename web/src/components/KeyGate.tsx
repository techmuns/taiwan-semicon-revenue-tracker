/**
 * The unlock screen, shown when the API answers 401.
 *
 * The Worker derives its access posture from which secrets are set
 * (worker/src/access.ts). Once `DASHBOARD_KEY` exists, every `/api/*` route needs
 * a credential - so without this screen the dashboard renders six identical
 * "unauthorized" cards and offers no way to fix any of them, which is what a
 * missing login looks like from the outside.
 *
 * Three deliberate choices:
 *
 *  - It replaces the whole shell rather than sitting in a card. Nothing behind it
 *    can load, so drawing the header, the tab strip, and six error states around
 *    it would be six lies about what is available.
 *  - The key goes out in a POST body, never a query string: a URL lands in browser
 *    history, in any intermediary's logs, and in Cloudflare's own request logs. The
 *    Worker exchanges it for an HttpOnly cookie, so this component is the last
 *    place any JavaScript sees it. It is never written to localStorage.
 *  - A rejected key is a state of this form, not an error state. It says what to do
 *    next and leaves the field focused with its contents selected.
 *
 * On success the page reloads rather than re-running the queries in place. The
 * cookie is HttpOnly and therefore invisible to this code; a reload is the honest
 * way to restart every query with it attached, and it costs one round trip once.
 */

import { useRef, useState } from "react";
import type { FormEvent } from "react";

import { api } from "../api";

type Status = "idle" | "checking" | "rejected" | "unreachable";

export function KeyGate({ onUnlocked }: { onUnlocked: () => void }) {
  const [key, setKey] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const input = useRef<HTMLInputElement>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!key || status === "checking") return;
    setStatus("checking");
    try {
      const ok = await api.auth(key);
      if (ok) {
        onUnlocked();
        return;
      }
      setStatus("rejected");
      input.current?.select();
    } catch {
      // A network failure here is not a wrong key, and saying "invalid key" would
      // send the reader looking for a new one instead of at their connection.
      setStatus("unreachable");
    }
  }

  const message =
    status === "rejected"
      ? "That key was not accepted. Check it for a trailing space or a truncated paste."
      : status === "unreachable"
        ? "Could not reach the API to check the key. Try again in a moment."
        : null;

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        background: "var(--page-bg)",
      }}
    >
      <form
        onSubmit={submit}
        style={{
          width: "100%",
          maxWidth: 380,
          background: "var(--card-bg)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-card)",
          padding: "20px 22px 18px",
        }}
      >
        <div className="eyebrow">Taiwan Semi Revenue</div>
        <h1
          style={{
            margin: "6px 0 0",
            fontSize: 15,
            fontWeight: 600,
            letterSpacing: "-0.015em",
            color: "var(--text-primary)",
          }}
        >
          This dashboard needs a key
        </h1>
        <p
          id="gate-note"
          style={{
            margin: "6px 0 16px",
            fontSize: 12,
            lineHeight: 1.5,
            color: "var(--text-muted)",
          }}
        >
          The API is in shared-key mode. The key is exchanged once for a session
          cookie that lasts 30 days; it is not stored in this browser and never
          appears in the URL.
        </p>

        <label
          htmlFor="dashboard-key"
          className="eyebrow"
          style={{ display: "block", marginBottom: 5 }}
        >
          Shared key
        </label>
        <input
          id="dashboard-key"
          ref={input}
          type="password"
          value={key}
          autoFocus
          autoComplete="current-password"
          spellCheck={false}
          aria-describedby="gate-note"
          aria-invalid={status === "rejected"}
          onChange={(e) => {
            setKey(e.target.value);
            if (status !== "checking") setStatus("idle");
          }}
          style={{
            width: "100%",
            height: 32,
            padding: "0 9px",
            fontSize: 12.5,
            color: "var(--text-primary)",
            background: "var(--card-bg)",
            border: `1px solid ${
              status === "rejected" ? "var(--error-border)" : "var(--border-solid)"
            }`,
            borderRadius: "var(--radius-control)",
          }}
        />

        {/* Reserved height, so the button does not jump down when this appears. */}
        <div
          role={status === "rejected" || status === "unreachable" ? "alert" : undefined}
          style={{
            minHeight: 30,
            paddingTop: 6,
            fontSize: 11.5,
            lineHeight: 1.4,
            color: status === "rejected" ? "var(--error-red)" : "var(--text-muted)",
          }}
        >
          {message}
        </div>

        <button
          type="submit"
          disabled={!key || status === "checking"}
          style={{
            width: "100%",
            height: 32,
            fontSize: 12.5,
            fontWeight: 600,
            color: "var(--primary-text)",
            background: "var(--primary-light)",
            border: "1px solid var(--primary-border)",
            borderRadius: "var(--radius-control)",
            cursor: key && status !== "checking" ? "pointer" : "default",
            opacity: !key || status === "checking" ? 0.55 : 1,
            transition: "var(--ease)",
          }}
        >
          {status === "checking" ? "Checking…" : "Unlock"}
        </button>

        <div
          style={{
            marginTop: 14,
            paddingTop: 12,
            borderTop: "1px solid var(--border)",
            fontSize: 11,
            lineHeight: 1.5,
            color: "var(--text-hint)",
          }}
        >
          No key? Whoever deployed this set it with{" "}
          <code style={{ color: "var(--text-muted)" }}>wrangler secret put DASHBOARD_KEY</code>.{" "}
          <a
            href="/api/health"
            style={{ color: "var(--primary-text)", textDecoration: "none" }}
          >
            /api/health
          </a>{" "}
          stays open, so the service can be confirmed up without one.
        </div>
      </form>
    </div>
  );
}
