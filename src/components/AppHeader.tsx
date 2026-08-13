'use client';

import Link from 'next/link';
import Image from 'next/image';
import { usePathname, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

export default function AppHeader() {
  const pathname = usePathname();
  const router = useRouter();
  const hide =
    pathname === '/' ||
    pathname.startsWith('/login') ||
    pathname.startsWith('/signup');

  if (hide) return null;

  const signOut = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push('/login');
    router.refresh();
  };

  return (
    <header className="sc-header">
      <Link href="/hub" className="sc-brand">
        <Image src="/logo.png" alt="Sortcerer" width={40} height={40} className="sc-logo" priority />
        <span className="sc-brand-text">Sortcerer</span>
      </Link>
      <nav className="sc-nav">
        <Link href="/hub" className={pathname.startsWith('/hub') ? 'active' : ''}>
          Order Hub
        </Link>
        <Link href="/settings" className={pathname.startsWith('/settings') ? 'active' : ''}>
          Settings
        </Link>
        <Link href="/billing" className={pathname.startsWith('/billing') ? 'active' : ''}>
          Billing
        </Link>
        <button type="button" className="sc-signout" onClick={signOut}>
          Sign out
        </button>
      </nav>
    </header>
  );
}
