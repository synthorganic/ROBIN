import { useEffect, useState, useRef, useCallback, useMemo } from 'react';

// ROBIN Ops Spinner Verbs - for active processing states
// During streaming, shows "replying..." instead of verb rotation
const ROBIN_SPINNER_VERBS = [
  'Synergizing', 'Operationalizing', 'De-risking', 'Mapping', 'Tightening',
  'Consulting', 'Aligning', 'Triangulating', 'Sleuthing', 'Correlating',
  'Observing', 'Indexing', 'Surfacing', 'Scheming', 'Redacting',
  'Hardening', 'Modeling', 'Deconflicting', 'Operationalizing',
  'Summoning', 'Appeasing', 'Rotating', 'Fingerprinting raccoons', 'Auditing',
  'Polishing the panopticon', 'Waterboarding the JSON', 'Teaching Excel fear',
  'Encrypting', 'Disambiguating', 'Backtracing', 'Staring into procurement',
  'Proselytizing the data', 'Reading the runes', 'Consulting the owl',
  'Whispering to the ontology', 'Performing graph liturgy', 'Blessing the data lake',
  'Baptizing the pipeline', 'Invoking the dashboard', 'Monitoring',
  'Watching', 'Locking', 'Checking', 'Closing', 'Sanitizing', 'Containing',
  'Redacting', 'Escalating', 'Deconflicting', 'Hardening',
];

const SCRAMBLE_SPEED_MS = 100;
const CHARACTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!@#$%^&*()_+-=[]{}|;:,.<>?';

interface SpinnerVerbProps {
  stage?: 'thinking' | 'tool_use' | 'streaming' | null;
  color?: 'primary' | 'green';
}

export function SpinnerVerb({ stage, color = 'primary' }: SpinnerVerbProps) {
  const isProcessing = stage === 'thinking' || stage === 'tool_use';
  const isStreaming = stage === 'streaming';
  const [currentVerbIndex, setCurrentVerbIndex] = useState(0);
  const [displayText, setDisplayText] = useState(ROBIN_SPINNER_VERBS[0] + '...');
  const [isAnimating, setIsAnimating] = useState(false);
  const [isDecrypted, setIsDecrypted] = useState(true);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Get characters to use for scrambling
  const availableChars = useMemo(() => {
    return CHARACTERS.split('');
  }, []);

  // Scramble text function
  const scrambleText = useCallback((verb: string, revealed: Set<number>) => {
    return verb.split('').map((char, i) => {
      if (char === ' ') return ' ';
      if (revealed.has(i)) return verb[i];
      return availableChars[Math.floor(Math.random() * availableChars.length)];
    }).join('');
  }, [availableChars]);

  // Trigger decryption (scramble then reveal)
  const triggerDecrypt = useCallback(() => {
    if (isAnimating) return;

    setIsAnimating(true);
    setIsDecrypted(false);
  }, [isAnimating]);

  // Animation effect
  useEffect(() => {
    if (!isAnimating || !isProcessing) return;

    let iteration = 0;
    let currentVerb = ROBIN_SPINNER_VERBS[currentVerbIndex] + '...';
    let revealed = new Set<number>();

    timerRef.current = setInterval(() => {
      if (iteration < currentVerb.length) {
        revealed.add(iteration);
        setDisplayText(scrambleText(currentVerb, revealed));
        iteration++;
      } else {
        clearInterval(timerRef.current!);
        setIsAnimating(false);
        setIsDecrypted(true);
        setDisplayText(currentVerb);
      }
    }, SCRAMBLE_SPEED_MS);

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [isAnimating, isProcessing, currentVerbIndex, scrambleText]);

  // Handle verb rotation and animation
  useEffect(() => {
    if (isStreaming) {
      // Show "replying" text during streaming instead of verb rotation
      if (!isAnimating && isDecrypted) {
        setDisplayText('replying...');
      }
    } else if (isProcessing) {
      // If not animating and not decrypted (initial state), trigger first animation
      if (!isAnimating && !isDecrypted) {
        // Start first verb immediately
        setDisplayText(ROBIN_SPINNER_VERBS[0] + '...');
        setTimeout(triggerDecrypt, 100);
      }
      // Otherwise rotate to next verb
      else if (!isAnimating && isDecrypted) {
        setCurrentVerbIndex(prevIndex => (prevIndex + 1) % ROBIN_SPINNER_VERBS.length);
        setTimeout(triggerDecrypt, 100);
      }
    } else {
      // Reset when not processing
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      setIsAnimating(false);
      setIsDecrypted(false);
      setDisplayText('Ready...');
    }

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [isProcessing, isStreaming, isAnimating, isDecrypted, triggerDecrypt]);

  const colorClass = color === 'green' ? 'text-green' : 'text-primary';

  return (
    <span className={`text-[0.833rem] font-medium ${colorClass} tracking-wide`}>
      {displayText}
    </span>
  );
}

export default SpinnerVerb;
