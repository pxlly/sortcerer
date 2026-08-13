import type { Metadata } from 'next';
import { Fraunces, Manrope } from 'next/font/google';
import AppHeader from '@/components/AppHeader';
import './globals.css';

const fraunces = Fraunces({
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
});

const manrope = Manrope({
  subsets: ['latin'],
  variable: '--font-body',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Sortcerer — Order Hub for Amazon sellers',
  description: 'Unshipped orders to labels, packing, Keepa enrich, and master reference.',
  icons: { icon: '/logo.png' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${fraunces.variable} ${manrope.variable} antialiased`}>
        <div className="sc-shell">
          <AppHeader />
          <main className="sc-main">{children}</main>
        </div>
      </body>
    </html>
  );
}
