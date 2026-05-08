import { useState, useEffect } from 'react';

/** FuzzyText - Subtle text jitter animation for chat messages */
export function FuzzyText({
  text,
  fuzzRange = 30,
  //   speed = 60,
}: {
  text: string;
  fuzzRange?: number;
  speed?: number;
}) {
  // eslint-disable-next-line no-unused-vars
  const [offset, setOffset] = useState({ x: 0, y: 0 });  // eslint-disable-line no-unused-vars

  useEffect(() => {
    let animationFrameId: number;

    const animate = () => {
      // Subtle random jitter for fuzzy effect
      const jitterX = (Math.random() - 0.5) * fuzzRange / 10;
      const jitterY = (Math.random() - 0.5) * fuzzRange / 10;
      setOffset({ x: jitterX, y: jitterY });
      animationFrameId = requestAnimationFrame(animate);
    };

    animate();
    return () => cancelAnimationFrame(animationFrameId);
  }, [fuzzRange]);

  return (
    <span
      style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}
      className="inline-block">
      {text}
    </span>
  );
}
