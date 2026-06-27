/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  distDir: '../src/webui-dist',
  assetPrefix: '/dashboard',
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
};

module.exports = nextConfig;
