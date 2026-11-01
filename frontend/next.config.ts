import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // No dev-mode badge over the app: it shows up in screen recordings.
  devIndicators: false,
  async rewrites() {
    // Dev proxy: the FastAPI backend owns every /api/* route.
    return [
      { source: "/api/:path*", destination: "http://127.0.0.1:8000/api/:path*" },
    ];
  },
};

export default nextConfig;
