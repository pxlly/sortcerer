import Image from 'next/image';
import Link from 'next/link';

export default function HomePage() {
  return (
    <div className="sc-landing">
      <div className="sc-landing-hero">
        <Image
          src="/logo.png"
          alt="Sortcerer logo"
          width={120}
          height={120}
          priority
          className="sc-logo"
        />
        <h1>Sortcerer</h1>
        <p className="tagline">
          Automation solutions for E-commerce brands
        </p>
        <div className="sc-cta-row">
          <Link href="/signup" className="sc-cta sc-cta-primary">
            Start — $300 setup, then $175/mo
          </Link>
          <Link href="/login" className="sc-cta sc-cta-ghost">
            Sign in
          </Link>
        </div>
      </div>
    </div>
  );
}
