import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["exceljs", "@neondatabase/serverless", "ws"],
  eslint: { ignoreDuringBuilds: false },
};

export default nextConfig;
