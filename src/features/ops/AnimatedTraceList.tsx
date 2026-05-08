import type { CSSProperties } from 'react';

export interface AnimatedTraceItem {
  id: string;
  label: string;
  text: string;
}

interface AnimatedTraceListProps {
  items: AnimatedTraceItem[];
  className?: string;
  delayMs?: number;
}

export default function AnimatedTraceList({ items, className, delayMs = 90 }: AnimatedTraceListProps) {
  return (
    <div className={['ops-animated-trace-list', className].filter(Boolean).join(' ')}>
      {items.map((item, index) => {
        const style: CSSProperties = { animationDelay: `${index * delayMs}ms` };
        return (
          <div key={item.id} className="ops-animated-trace-item" style={style}>
            <div className="ops-animated-trace-label">{item.label}</div>
            <div className="ops-animated-trace-text">{item.text}</div>
          </div>
        );
      })}
    </div>
  );
}
