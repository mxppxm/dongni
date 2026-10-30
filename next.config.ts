import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3", "ws", "sherpa-onnx-node"],
  devIndicators: false,
};

export default nextConfig;
