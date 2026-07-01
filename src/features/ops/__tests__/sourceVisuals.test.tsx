import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import {
  sourceMarkerKind,
  SourceIcon,
  sourceMarkerSvgPath,
  sourceMarkerLabel,
} from '../sourceVisuals';

describe('sourceVisuals', () => {
  describe('sourceMarkerKind', () => {
    it('maps manual to human', () => {
      expect(sourceMarkerKind('manual')).toBe('human');
    });

    it('maps trackedflights to aviation', () => {
      expect(sourceMarkerKind('trackedflights')).toBe('aviation');
    });

    it('maps faf and ntad to logistics', () => {
      expect(sourceMarkerKind('faf')).toBe('logistics');
      expect(sourceMarkerKind('ntad')).toBe('logistics');
    });

    it('maps marinecadastre, mobilitydb, tigerline to transport', () => {
      expect(sourceMarkerKind('marinecadastre')).toBe('transport');
      expect(sourceMarkerKind('mobilitydb')).toBe('transport');
      expect(sourceMarkerKind('tigerline')).toBe('transport');
    });

    it('maps geoSensor sources correctly', () => {
      expect(sourceMarkerKind('radnet')).toBe('geoSensor');
      expect(sourceMarkerKind('eurdep')).toBe('geoSensor');
      expect(sourceMarkerKind('safecast')).toBe('geoSensor');
      expect(sourceMarkerKind('gmcmap')).toBe('geoSensor');
      expect(sourceMarkerKind('aqi')).toBe('geoSensor');
    });

    it('maps gdelt to openSource', () => {
      expect(sourceMarkerKind('gdelt')).toBe('openSource');
    });

    it('maps trafficcams to camera', () => {
      expect(sourceMarkerKind('trafficcams')).toBe('camera');
    });

    it('maps firms to wildfire', () => {
      expect(sourceMarkerKind('firms')).toBe('wildfire');
    });

    it('maps nrcevents and nrcreactorstatus to nuclear', () => {
      expect(sourceMarkerKind('nrcevents')).toBe('nuclear');
      expect(sourceMarkerKind('nrcreactorstatus')).toBe('nuclear');
    });

    it('maps gdacs, nws, usgs to alert', () => {
      expect(sourceMarkerKind('gdacs')).toBe('alert');
      expect(sourceMarkerKind('nws')).toBe('alert');
      expect(sourceMarkerKind('usgs')).toBe('alert');
    });

    it('returns generic for unknown sources', () => {
      expect(sourceMarkerKind('unknown-source')).toBe('generic');
    });

    it('returns generic when sourceId is undefined', () => {
      expect(sourceMarkerKind(undefined)).toBe('generic');
    });

    it('returns generic when sourceId is empty string', () => {
      expect(sourceMarkerKind('')).toBe('generic');
    });
  });

  describe('SourceIcon', () => {
    it('renders icon with default size', () => {
      render(<SourceIcon sourceId="manual" />);
      const svg = document.querySelector('svg');
      expect(svg).toBeInTheDocument();
    });

    it('accepts size prop and renders correctly', () => {
      render(<SourceIcon sourceId="trackedflights" size={24} />);
      const svg = document.querySelector('svg');
      expect(svg).toBeInTheDocument();
    });
  });

  describe('sourceMarkerSvgPath', () => {
    it('returns a valid SVG path string for all kinds', () => {
      const kinds = [
        'human', 'aviation', 'logistics', 'transport',
        'geoSensor', 'openSource', 'camera', 'wildfire',
        'nuclear', 'alert', 'saved', 'generic',
      ] as const;

      for (const kind of kinds) {
        const path = sourceMarkerSvgPath(kind);
        expect(path).toBeTypeOf('string');
        expect(path.length).toBeGreaterThan(0);
      }
    });
  });

  describe('sourceMarkerLabel', () => {
    it('returns human-readable labels', () => {
      expect(sourceMarkerLabel('human')).toBe('Human Intel');
      expect(sourceMarkerLabel('aviation')).toBe('Aviation');
      expect(sourceMarkerLabel('logistics')).toBe('Logistics');
      expect(sourceMarkerLabel('transport')).toBe('Transport');
      expect(sourceMarkerLabel('geoSensor')).toBe('Geo Sensor');
      expect(sourceMarkerLabel('openSource')).toBe('Open Source');
      expect(sourceMarkerLabel('camera')).toBe('Camera Feed');
      expect(sourceMarkerLabel('wildfire')).toBe('Wildfire');
      expect(sourceMarkerLabel('nuclear')).toBe('Nuclear');
      expect(sourceMarkerLabel('alert')).toBe('Alert');
      expect(sourceMarkerLabel('saved')).toBe('Saved Point');
    });
  });
});
