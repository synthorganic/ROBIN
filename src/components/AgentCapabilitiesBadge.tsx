/** Agent Capabilities Badge */
import { useState, useEffect } from 'react';

export function AgentCapabilitiesBadge() {
  const [capabilities, setCapabilities] = useState<string[]>([]);

  useEffect(() => {
    async function checkCapabilities() {
      try {
        const res = await fetch('/api/agent-tools');
        if (res.ok) {
          const data = await res.json();
          setCapabilities(data.tools || ['glob', 'grep', 'sleep']);
        }
      } catch {
        setCapabilities(['glob', 'grep', 'sleep']);
      }
    }
    checkCapabilities();
  }, []);

  return (
    <div className='flex flex-col gap-1 text-xs'>
      {capabilities.map((cap) => (
        <span key={cap} className='inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-gray-800/50 border border-gray-700/50 hover:border-blue-600 transition-all cursor-help'>
          <span className='w-1.5 h-1.5 rounded-full bg-blue-400'></span>
          <span className='capitalize'>{cap}</span>
        </span>
      ))}
    </div>
  );
}
