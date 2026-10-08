import { Inter } from 'next/font/google';
import '../src/index.css';
import '../src/theme.css';
import '../src/App.css';

const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-inter',
  display: 'swap'
});

export const metadata = {
  title: 'Social Hub',
  description: 'Connect WhatsApp, Instagram, Facebook, LinkedIn, YouTube and Google Business, schedule posts, and work a unified inbox with one customer record per conversation.'
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}
