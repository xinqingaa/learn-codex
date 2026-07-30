import type { NextConfig } from "next";

// basePath is only set for the GitHub Pages deployment (project site served at
// https://<user>.github.io/learn-codex/). Local dev and root-domain hosts (e.g.
// Vercel) leave it empty. The deploy workflow sets NEXT_BASE_PATH=/learn-codex.
const basePath = process.env.NEXT_BASE_PATH ?? "";

const nextConfig: NextConfig = {
  output: "export",
  basePath: basePath || undefined,
  assetPrefix: basePath || undefined,
  images: { unoptimized: true },
  trailingSlash: true,
};

export default nextConfig;
