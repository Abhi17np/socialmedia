/** @type {import('next').NextConfig} */
const nextConfig = {
  // Dev-only build indicator — default position (bottom-left) overlaps
  // the sidebar's Log out button in this layout.
  devIndicators: { position: 'bottom-right' },
  // A self-contained server bundle (just the files actually needed at
  // runtime) instead of requiring the full node_modules tree in the
  // production image — see frontend/Dockerfile.
  output: 'standalone'
};

module.exports = nextConfig;
