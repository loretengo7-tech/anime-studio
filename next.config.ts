import type { NextConfig } from "next";

const isStatic = process.env.STATIC_EXPORT === "1";
// Optional sub-path hosting (GitHub Pages project sites): NEXT_PUBLIC_BASE_PATH=/repo
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

const base = {
  ...(basePath ? { basePath } : {}),
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

const nextConfig: NextConfig = isStatic
  ? {
      ...base,
      output: "export",
      distDir: "dist-static",
      images: { unoptimized: true },
    }
  : {
      ...base,
      output: "standalone",
    };

export default nextConfig;
