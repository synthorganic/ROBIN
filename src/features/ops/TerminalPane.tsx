import { useEffect, useRef } from 'react';
import { FitAddon } from 'xterm-addon-fit';
import { Terminal } from 'xterm';
import 'xterm/css/xterm.css';
import type { TerminalState } from './api';

interface TerminalPaneProps {
  terminal: TerminalState;
  onInput?: (input: string) => Promise<void>;
  onResize?: (cols: number, rows: number) => Promise<void>;
}

const TERMINAL_THEME = {
  background: '#040806',
  foreground: '#eefaf0',
  cursor: '#3dff65',
  cursorAccent: '#040806',
  selectionBackground: 'rgba(61, 255, 101, 0.18)',
  black: '#040806',
  red: '#ff6d72',
  green: '#3dff65',
  yellow: '#d8ff7f',
  blue: '#7cc6ff',
  magenta: '#94ffb0',
  cyan: '#77f2d9',
  white: '#eefaf0',
  brightBlack: '#4b5f54',
  brightRed: '#ff9ca0',
  brightGreen: '#7dff99',
  brightYellow: '#eeff9a',
  brightBlue: '#a3d6ff',
  brightMagenta: '#c3ffd0',
  brightCyan: '#aafaea',
  brightWhite: '#ffffff',
};

export default function TerminalPane({ terminal, onInput, onResize }: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const renderedLengthRef = useRef(0);
  const pendingInputRef = useRef('');
  const flushTimerRef = useRef<number | null>(null);
  const lastResizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const resizeScheduledRef = useRef(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const xterm = new Terminal({
      allowTransparency: true,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: 'block',
      disableStdin: terminal.readonly,
      fontFamily: `'IBM Plex Mono', 'JetBrains Mono', 'Consolas', monospace`,
      fontSize: 14,
      lineHeight: 1.28,
      scrollback: 5000,
      tabStopWidth: 2,
      theme: TERMINAL_THEME,
    });
    const fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);
    xterm.open(host);
    fitAddon.fit();

    terminalRef.current = xterm;
    fitAddonRef.current = fitAddon;
    renderedLengthRef.current = 0;

    const flushInput = () => {
      flushTimerRef.current = null;
      const nextInput = pendingInputRef.current;
      pendingInputRef.current = '';
      if (!nextInput || !onInput) return;
      void onInput(nextInput);
    };

    const scheduleFlush = () => {
      if (flushTimerRef.current != null) return;
      flushTimerRef.current = window.setTimeout(flushInput, 18);
    };

    const dataDisposable = terminal.readonly || !onInput
      ? null
      : xterm.onData((data) => {
        pendingInputRef.current += data;
        if (data.includes('\r') || data.includes('\x03') || pendingInputRef.current.length >= 16) {
          flushInput();
          return;
        }
        scheduleFlush();
      });

    const pushResize = () => {
      fitAddon.fit();
      const dims = { cols: xterm.cols, rows: xterm.rows };
      const previous = lastResizeRef.current;
      if (!onResize) return;
      if (previous && previous.cols === dims.cols && previous.rows === dims.rows) return;
      lastResizeRef.current = dims;
      void onResize(dims.cols, dims.rows);
    };

    pushResize();
    const observer = new ResizeObserver(() => {
      // Debounce: only schedule one resize per frame to prevent rapid-fire resize calls
      if (!resizeScheduledRef.current) {
        resizeScheduledRef.current = true;
        window.requestAnimationFrame(() => {
          resizeScheduledRef.current = false;
          pushResize();
        });
      }
    });
    observer.observe(host);

    host.addEventListener('click', () => xterm.focus());
    xterm.focus();

    return () => {
      observer.disconnect();
      dataDisposable?.dispose();
      if (flushTimerRef.current != null) {
        window.clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      if (pendingInputRef.current && onInput) {
        const nextInput = pendingInputRef.current;
        pendingInputRef.current = '';
        void onInput(nextInput);
      }
      terminalRef.current = null;
      fitAddonRef.current = null;
      renderedLengthRef.current = 0;
      xterm.dispose();
    };
  }, [onInput, onResize, terminal.id, terminal.readonly]);

  useEffect(() => {
    const xterm = terminalRef.current;
    if (!xterm) return;

    const nextText = terminal.buffer.join('');
    if (nextText.length < renderedLengthRef.current) {
      xterm.clear();
      if ('reset' in xterm && typeof xterm.reset === 'function') {
        xterm.reset();
      }
      if (nextText) {
        xterm.write(nextText);
      }
      renderedLengthRef.current = nextText.length;
      return;
    }

    const nextChunk = nextText.slice(renderedLengthRef.current);
    if (!nextChunk) return;
    xterm.write(nextChunk);
    renderedLengthRef.current = nextText.length;
  }, [terminal.buffer, terminal.lastUpdated]);

  return <div ref={hostRef} className="ops-terminal-canvas" data-readonly={terminal.readonly} />;
}
