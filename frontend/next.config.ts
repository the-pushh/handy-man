import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // No dev-mode badge over the app: it shows up in screen recordings.
  devIndicators: false,
  async rewrites() {
    // Local dev only: the FastAPI backend on this machine owns /api/*.
    // In production middleware.ts proxies /api/* to BACKEND_URL instead.
    if (process.env.BACKEND_URL || process.env.NODE_ENV === "production") return [];
    return [{ source: "/api/:path*", destination: "http://127.0.0.1:8000/api/:path*" }];
  },
};

export default nextConfig;
