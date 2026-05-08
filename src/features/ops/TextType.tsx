import { useEffect, useState } from 'react';

interface TextTypeProps {
  text: string;
  speed?: number;
  className?: string;
  as?: 'span' | 'div';
}

export default function TextType({ text, speed = 12, className, as = 'span' }: TextTypeProps) {
  const value = String(text || '');
  const [typingState, setTypingState] = useState(() => ({
    value,
    length: speed <= 0 ? value.length : 0,
  }));

  const visibleLength = typingState.value === value
    ? typingState.length
    : speed <= 0
      ? value.length
      : 0;

  useEffect(() => {
    if (!value || speed <= 0) return;

    let cursor = 0;
    const timer = window.setInterval(() => {
      cursor += 1;
      if (cursor >= value.length) {
        setTypingState({ value, length: value.length });
        window.clearInterval(timer);
        return;
      }
      setTypingState({ value, length: cursor });
    }, speed);

    return () => window.clearInterval(timer);
  }, [speed, value]);

  const typed = value.slice(0, visibleLength);
  const complete = visibleLength >= value.length;
  const content = (
    <>
      {typed}
      {!complete && <span className="ops-text-type-caret" aria-hidden="true">|</span>}
    </>
  );

  if (as === 'div') {
    return <div className={className}>{content}</div>;
  }

  return <span className={className}>{content}</span>;
}
