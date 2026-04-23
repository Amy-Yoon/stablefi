import { NextRequest } from "next/server";
import { STABLENET_TESTNET } from "@/lib/chain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Same-origin RPC proxy.
 *
 * Browser → POST /api/rpc  →  Next.js server (no CORS) → StableNet RPC
 *
 * Why: Public RPCs often don't set CORS headers for arbitrary origins, so
 * fetch() from the browser fails with "HTTP request failed". Routing through
 * our own backend avoids CORS entirely and also lets us centralize logging
 * or a future rate-limit layer.
 */
// Retry transient upstream failures server-side before letting them reach
// the browser. This absorbs the rate-limit / 5xx blips that otherwise bubble
// up to viem as "too many errors". 3 attempts with exponential backoff
// (250ms → 500ms → 1000ms) — total worst-case added latency ≈ 1.75s.
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  attempts = 3,
): Promise<{ response: Response; text: string }> {
  let lastErr: any = null;
  let lastStatus = 0;
  let lastText = "";
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, init);
      const text = await res.text();
      // 429 (rate limit) / 5xx (server) → retry. 4xx other than 429 → return.
      if (res.status === 429 || res.status >= 500) {
        lastStatus = res.status;
        lastText = text;
        await new Promise((r) => setTimeout(r, 250 * Math.pow(2, i)));
        continue;
      }
      return { response: res, text };
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 250 * Math.pow(2, i)));
    }
  }
  if (lastErr) throw lastErr;
  // Surface the last non-retryable response so the caller can see the real
  // status instead of a generic "too many errors".
  return {
    response: new Response(lastText, { status: lastStatus || 502 }),
    text: lastText,
  };
}

export async function POST(req: NextRequest) {
  const body = await req.text();

  try {
    const { response: upstream, text } = await fetchWithRetry(
      STABLENET_TESTNET.rpcUrl,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        // Server-side fetch — no CORS, no credentials.
        cache: "no-store",
      },
    );

    // Force every response to be valid JSON-RPC. If upstream returns an HTML
    // error page (Cloudflare 429, gateway timeout, maintenance splash), viem
    // would otherwise try to JSON.parse HTML, throw, and retry endlessly —
    // surfacing as "too many errors". Wrap non-JSON bodies in a proper
    // JSON-RPC error object so viem can classify them.
    const trimmed = text.trim();
    const looksLikeJson = trimmed.startsWith("{") || trimmed.startsWith("[");
    if (!looksLikeJson) {
      console.error("[api/rpc] non-JSON upstream body", {
        status: upstream.status,
        snippet: trimmed.slice(0, 200),
      });
      // Try to extract an id from the request so viem can match the response.
      let reqId: any = null;
      try {
        reqId = JSON.parse(body)?.id ?? null;
      } catch {
        /* batch or malformed — leave null */
      }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: `Upstream RPC returned non-JSON (status ${upstream.status})`,
            data: trimmed.slice(0, 200),
          },
          id: reqId,
        }),
        {
          status: 200, // 200 with jsonrpc error — don't make viem HTTP-retry
          headers: { "content-type": "application/json" },
        },
      );
    }

    return new Response(text, {
      status: upstream.status,
      headers: { "content-type": "application/json" },
    });
  } catch (e: any) {
    console.error("[api/rpc] upstream fetch failed", e);
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32603, message: e?.message ?? "upstream failed" },
        id: null,
      }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }
}

export async function GET() {
  return new Response(
    JSON.stringify({ ok: true, upstream: STABLENET_TESTNET.rpcUrl }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
