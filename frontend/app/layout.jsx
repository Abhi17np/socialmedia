import { Inter, JetBrains_Mono } from 'next/font/google';
import '../src/styles/app.css';

const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-inter',
  display: 'swap'
});

const jetbrains = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-jetbrains',
  display: 'swap'
});

export const metadata = {
  title: 'Social Hub',
  description:
    'Connect WhatsApp, Instagram, Facebook, LinkedIn, YouTube and Google Business, schedule posts, and work a unified inbox with one customer record per conversation.'
};

// Applied before first paint so a dark-theme user never sees a white
// flash — the class the rest of the system keys off lives on <html>.
const THEME_BOOTSTRAP = `(function(){try{var t=localStorage.getItem('theme');if(t==='dark'||(!t&&window.matchMedia('(prefers-color-scheme: dark)').matches)){document.documentElement.classList.add('dark')}}catch(e){}})()`;

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrains.variable} h-full`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body className="h-full">{children}</body>
    </html>
  );
}
