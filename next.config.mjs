/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",              // static export — deployable to any CDN / Netlify / GH Pages
  images: { unoptimized: true }, // required for static export
  trailingSlash: true,
  webpack: (config) => {
    // @dicebear/core statically imports toPng/toJpeg from @dicebear/converter,
    // which pulls in the native-binding `@resvg/resvg-js` package and
    // `node:fs/promises` -- neither bundleable for the browser. The guide
    // avatar feature (components/avatar/robot.tsx) only ever calls
    // toDataUriSync() to render an inline SVG data URI, never toPng()/toFile(),
    // so that whole PNG-rasterization branch is genuinely dead code here.
    // Stub it out so webpack doesn't try to resolve it into the client bundle.
    config.resolve.alias = {
      ...config.resolve.alias,
      "@resvg/resvg-js": false,
    };
    // core.js's toFile() helper also has a conditional `import('node:fs/promises')`
    // in its non-browser branch (dead code here — toFile() is never called by
    // components/avatar/robot.tsx, which only uses toDataUriSync()), but webpack
    // still tries to statically resolve the node: URI scheme and fails. Mark it
    // external so webpack leaves the bare specifier alone instead of bundling it.
    config.externals = [
      ...(Array.isArray(config.externals) ? config.externals : []),
      { "node:fs/promises": "commonjs node:fs/promises" },
    ];
    return config;
  },
};
export default nextConfig;
