import { Suspense, lazy, useEffect, useState } from 'react';

const OpsOrb = lazy(() => import('./OpsOrb'));

function Placeholder() {
  return <div className="ops-orb-canvas" aria-hidden="true" />;
}

export default function DeferredOpsOrb() {
  const [enabled, setEnabled] = useState(() => (
    typeof window !== 'undefined'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ));

  useEffect(() => {
    if (enabled) return;

    const timer = window.setTimeout(() => setEnabled(true), 420);
    return () => window.clearTimeout(timer);
  }, [enabled]);

  if (!enabled) return <Placeholder />;

  return (
    <Suspense fallback={<Placeholder />}>
      <OpsOrb />
    </Suspense>
  );
}
