/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",              // static export — deployable to any CDN / Netlify / GH Pages
  images: { unoptimized: true }, // required for static export
  trailingSlash: true,
};
export default nextConfig;
