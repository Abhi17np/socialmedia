/** @type {import('next').NextConfig} */
const nextConfig = {
  // Dev-only build indicator — default position (bottom-left) overlaps
  // the sidebar's Log out button in this layout.
  devIndicators: { position: 'bottom-right' }
};

module.exports = nextConfig;
