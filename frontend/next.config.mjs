/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    // Dev proxy: the FastAPI backend owns every /api/* route.
    return [
      { source: "/api/:path*", destination: "http://127.0.0.1:8000/api/:path*" },
    ];
  },
};

export default nextConfig;
