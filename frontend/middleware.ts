/* Production proxy: the browser only ever talks to this origin. Every
   /api/* request is rewritten to the Cloud Run backend (a Vercel external
   rewrite, which waits up to 120s for the first byte; our slowest call
   is well under 60s). Two headers are added on the way:
     x-handyman-proxy  the shared secret; the backend rejects /api/*
                       without it, so its own URL can't be used to skip
                       the rate limits
     x-client-ip       the visitor's IP (from Vercel), for per-IP limits
   BACKEND_URL and PROXY_SECRET are server-side only (no NEXT_PUBLIC_),
   so neither reaches the browser. Without BACKEND_URL (local dev) this
   does nothing and next.config's dev rewrite applies. */

import { NextResponse, type NextRequest } from "next/server";

export const config = { matcher: "/api/:path*" };

export function middleware(req: NextRequest) {
  const backend = process.env.BACKEND_URL;
  if (!backend) return NextResponse.next();
  const target = new URL(req.nextUrl.pathname + req.nextUrl.search, backend);
  const headers = new Headers(req.headers);
  headers.set("x-handyman-proxy", process.env.PROXY_SECRET || "");
  const ip =
    req.headers.get("x-real-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "";
  headers.set("x-client-ip", ip);
  return NextResponse.rewrite(target, { request: { headers } });
}
