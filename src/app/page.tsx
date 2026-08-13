import Image from 'next/image';
import Link from 'next/link';

export default function HomePage() {
  return (
    <div className="sc-landing">
      <div className="sc-landing-hero">
        <Image src="/logo.png" alt="Sortcerer logo" width={120} height={120} priority />
        <h1>Sortcerer</h1>
        <p className="tagline">
          Order Hub for Amazon FBM — convert unshipped orders, pack boxes, enrich weights with Keepa,
          and print label headers that fit long titles.
        </p>
        <div className="sc-cta-row">
          <Link href="/signup" className="sc-cta sc-cta-primary">
            Start — $100/mo
          </Link>
          <Link href="/login" className="sc-cta sc-cta-ghost">
            Sign in
          </Link>
        </div>
      </div>
    </div>
  );
}
