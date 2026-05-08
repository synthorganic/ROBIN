import { useEffect, useRef } from 'react';

interface OpsOrbProps {
  hue?: number;
}

export default function OpsOrb({ hue = 130 }: OpsOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let frame = 0;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const { width, height } = canvas.getBoundingClientRect();
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const draw = (time: number) => {
      const { width, height } = canvas.getBoundingClientRect();
      ctx.clearRect(0, 0, width, height);
      const cx = width / 2;
      const cy = height / 2;
      const radius = Math.min(width, height) * 0.28;

      const t = time * 0.001;
      const pulse = prefersReducedMotion ? 0.5 : (Math.sin(t * 1.3) + 1) / 2;
      const ringShift = prefersReducedMotion ? 0.3 : (Math.sin(t * 0.7) + 1) / 2;

      const background = ctx.createRadialGradient(cx, cy, radius * 0.16, cx, cy, radius * 1.45);
      background.addColorStop(0, 'rgba(61,255,101,0.42)');
      background.addColorStop(0.4, 'rgba(24,73,49,0.30)');
      background.addColorStop(1, 'rgba(7,15,12,0)');
      ctx.fillStyle = background;
      ctx.beginPath();
      ctx.arc(cx, cy, radius * 1.5, 0, Math.PI * 2);
      ctx.fill();

      for (let index = 0; index < 4; index += 1) {
        const ringRadius = radius * (0.75 + index * 0.22 + ringShift * 0.04);
        ctx.strokeStyle = `hsla(${hue}, 100%, ${58 + index * 4}%, ${0.28 - index * 0.04})`;
        ctx.lineWidth = 1.2 + index * 0.25;
        ctx.beginPath();
        ctx.arc(cx, cy, ringRadius, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(t * 0.18);
      for (let index = 0; index < 18; index += 1) {
        const angle = (Math.PI * 2 * index) / 18;
        const orbitRadius = radius * (0.84 + (index % 3) * 0.18);
        const x = Math.cos(angle) * orbitRadius;
        const y = Math.sin(angle) * orbitRadius;
        ctx.fillStyle = `rgba(140,255,172,${0.16 + ((index + frame) % 4) * 0.08})`;
        ctx.beginPath();
        ctx.arc(x, y, 1.8 + (index % 3), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();

      const core = ctx.createRadialGradient(cx, cy, radius * 0.1, cx, cy, radius);
      core.addColorStop(0, `hsla(${hue}, 100%, 78%, ${0.85})`);
      core.addColorStop(0.35, `hsla(${hue}, 96%, 60%, ${0.38 + pulse * 0.12})`);
      core.addColorStop(1, 'rgba(8,20,14,0)');
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = `rgba(200,255,217,${0.5 + pulse * 0.2})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, radius * 0.42, 0, Math.PI * 2);
      ctx.stroke();

      if (!prefersReducedMotion) {
        frame = window.requestAnimationFrame(draw);
      }
    };

    resize();
    if (prefersReducedMotion) {
      draw(0);
    } else {
      frame = window.requestAnimationFrame(draw);
    }

    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('resize', resize);
      window.cancelAnimationFrame(frame);
    };
  }, [hue]);

  return <canvas ref={canvasRef} className="ops-orb-canvas" aria-hidden="true" />;
}
