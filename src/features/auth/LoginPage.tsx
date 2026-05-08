/**
 * LoginPage — Full-screen login gate for Nerve authentication.
 *
 * Renders a password form matching Nerve's dark cockpit theme.
 * Supports Enter-to-submit and auto-focuses the password input on mount.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import FuzzyText from '@/features/ops/FuzzyText';

interface LoginPageProps {
  onLogin: (password: string) => Promise<void>;
  error: string;
}

export function LoginPage({ onLogin, error }: LoginPageProps) {
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password.trim() || submitting) return;
    setSubmitting(true);
    try {
      await onLogin(password);
    } finally {
      setSubmitting(false);
    }
  }, [password, submitting, onLogin]);

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-10">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(61,255,101,0.14),transparent_34%),radial-gradient(circle_at_bottom_right,rgba(61,255,101,0.08),transparent_32%)]" />
      <div className="pointer-events-none absolute inset-0 opacity-35" style={{ background: "url('/branding/Background.svg') center / cover no-repeat" }} />
      <div className="shell-panel relative w-full max-w-[min(94vw,1120px)] overflow-hidden rounded-[32px] border border-primary/20 bg-[rgba(8,14,11,0.9)]">
        <div className="grid lg:grid-cols-[1.15fr_0.85fr]">
          <div className="border-b border-border/70 bg-gradient-to-br from-background via-card/80 to-secondary/70 px-6 py-8 sm:px-8 lg:border-b-0 lg:border-r">
            <div className="flex items-center gap-4">
              <div className="flex h-14 w-14 items-center justify-center overflow-hidden rounded-2xl border border-primary/20 bg-background/70">
                <img
                  src="/branding/ROBIN_brand.png"
                  alt="ROBIN brand mark"
                  className="h-full w-full object-cover object-[center_22%]"
                />
              </div>
              <div>
                <div className="text-xl font-semibold uppercase tracking-[0.34em] text-foreground/90">
                  ROBIN
                </div>
                <div className="text-[0.7rem] uppercase tracking-[0.24em] text-muted-foreground/80">
                  Threat Detection
                </div>
              </div>
            </div>
            <div className="mt-6 text-[0.667rem] font-medium uppercase tracking-[0.32em] text-primary/80">
              ROBIN Access
            </div>
            <div className="mt-3">
              <FuzzyText fontSize="clamp(2.2rem,5vw,4rem)">ROBIN</FuzzyText>
            </div>
            <p className="mt-4 max-w-[48ch] text-sm leading-6 text-muted-foreground sm:text-base">
              Local-first control for the central OpenClaw operator, the CLI coding lane, and the geo-linked operations map.
            </p>

            <div className="mt-6 overflow-hidden rounded-[26px] border border-primary/12">
              <img src="/branding/landing_hero_orbit.png" alt="ROBIN visual" className="h-48 w-full object-cover" />
            </div>

            <div className="mt-8 grid gap-3 sm:grid-cols-3">
              <div className="shell-panel rounded-2xl px-4 py-3">
                <div className="text-[0.667rem] font-medium uppercase tracking-[0.22em] text-muted-foreground">Agent</div>
                <div className="mt-2 text-sm font-medium text-foreground">Local API over OpenClaw</div>
              </div>
              <div className="shell-panel rounded-2xl px-4 py-3">
                <div className="text-[0.667rem] font-medium uppercase tracking-[0.22em] text-muted-foreground">Bridge</div>
                <div className="mt-2 text-sm font-medium text-foreground">CLI coding handoffs</div>
              </div>
              <div className="shell-panel rounded-2xl px-4 py-3">
                <div className="text-[0.667rem] font-medium uppercase tracking-[0.22em] text-muted-foreground">Map</div>
                <div className="mt-2 text-sm font-medium text-foreground">Documents, feeds, and analysis</div>
              </div>
            </div>
          </div>

          <div className="px-6 py-8 sm:px-8">
            <div className="text-[0.667rem] font-medium uppercase tracking-[0.3em] text-primary/80">
              Authentication Required
            </div>
            <h2 className="mt-3 text-2xl font-semibold tracking-[-0.04em] text-foreground">
              Unlock ROBIN
            </h2>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              Enter the password configured for this deployment. Your gateway token also works if password auth is using the fallback path.
            </p>

            <form onSubmit={handleSubmit} className="mt-8 space-y-4">
              <div>
                <label htmlFor="nerve-password" className="mb-2 block text-[0.733rem] font-medium uppercase tracking-[0.2em] text-muted-foreground">
                  Password
                </label>
                <Input
                  ref={inputRef}
                  id="nerve-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter password"
                  autoComplete="current-password"
                  disabled={submitting}
                />
              </div>

              {error && (
                <div className="rounded-2xl border border-destructive/30 bg-destructive/8 px-4 py-3 text-sm text-destructive">
                  {error}
                </div>
              )}

              <Button
                type="submit"
                disabled={submitting || !password.trim()}
                size="lg"
                className="w-full text-[0.733rem] uppercase tracking-[0.22em]"
              >
                {submitting ? 'Signing In…' : 'Enter ROBIN'}
              </Button>
            </form>

            <div className="mt-6 text-xs leading-5 text-muted-foreground">
              Need to recover access? Check the gateway configuration or deployment notes where the token was originally set.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
