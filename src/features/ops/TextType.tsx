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

  useEffect(() => {
    if (speed <= 0) {
      setTypingState({ value, length: value.length });
      return;
    }

    setTypingState((prev) => {
      if (prev.value === value) return prev;
      const nextLength = value.startsWith(prev.value)
        ? Math.min(prev.length, value.length)
        : 0;
      return { value, length: nextLength };
    });
  }, [speed, value]);

  useEffect(() => {
    if (!value || speed <= 0) return;
    if (typingState.value !== value) return;
    if (typingState.length >= value.length) return;

    const timer = window.setTimeout(() => {
      setTypingState((prev) => {
        if (prev.value !== value) return prev;
        return { value, length: Math.min(prev.length + 1, value.length) };
      });
    }, speed);

    return () => window.clearTimeout(timer);
  }, [speed, typingState.length, typingState.value, value]);

  const visibleLength = speed <= 0 ? value.length : typingState.length;
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
