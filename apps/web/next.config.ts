import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The backend URL is deployment config, read at request time.
  env: {},
  // Minimal standalone runner for the Docker image.
  output: "standalone",
};

export default nextConfig;
