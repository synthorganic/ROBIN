import {
  AlertTriangle,
  Camera,
  Flame,
  Folder,
  Globe2,
  MapPin,
  Orbit,
  Plane,
  RadioTower,
  ShipWheel,
  Truck,
  User,
} from 'lucide-react';

// Fixed: lucide-react icons accept size prop directly on component
type IconComponent = React.FC<React.SVGProps<SVGSVGElement>>;

export type SourceMarkerKind =
  | 'human'
  | 'aviation'
  | 'logistics'
  | 'transport'
  | 'geoSensor'
  | 'openSource'
  | 'camera'
  | 'wildfire'
  | 'nuclear'
  | 'alert'
  | 'saved'
  | 'generic';

/**
 * Determine the marker kind based on source ID
 */
export function sourceMarkerKind(sourceId?: string): SourceMarkerKind {
  if (!sourceId) return 'generic';
  
  switch (sourceId) {
    case 'manual':
      return 'human';
    case 'trackedflights':
      return 'aviation';
    case 'faf':
    case 'ntad':
      return 'logistics';
    case 'marinecadastre':
    case 'mobilitydb':
    case 'tigerline':
      return 'transport';
    case 'radnet':
    case 'eurdep':
    case 'safecast':
    case 'gmcmap':
    case 'aqi':
      return 'geoSensor';
    case 'gdelt':
      return 'openSource';
    case 'trafficcams':
      return 'camera';
    case 'firms':
      return 'wildfire';
    case 'nrcevents':
    case 'nrcreactorstatus':
      return 'nuclear';
    case 'gdacs':
    case 'nws':
    case 'usgs':
      return 'alert';
    default:
      return 'generic';
  }
}

/**
 * Icon mapping for marker kinds
 */
const MARKER_ICONS: Record<SourceMarkerKind, IconComponent> = {
  human: User,
  aviation: Plane,
  logistics: Truck,
  transport: ShipWheel,
  geoSensor: Orbit,
  openSource: Globe2,
  camera: Camera,
  wildfire: Flame,
  nuclear: RadioTower,
  alert: AlertTriangle,
  saved: MapPin,
  generic: Folder,
};

/**
 * Source icon component - use this for Data Sources panel and map markers
 */
export function SourceIcon({ sourceId, size = 16 }: { sourceId?: string; size?: number }) {
  const kind = sourceMarkerKind(sourceId);
  const Icon = MARKER_ICONS[kind];
  // lucide-react icons accept size as a direct prop
  return <Icon width={size} height={size} />;
}

/**
 * SVG path for marker pin shape
 */
export function sourceMarkerSvgPath(_kind: SourceMarkerKind): string {
  // Standard marker pin shape with slight variations based on category
  // This is a base path that can be rendered in SVG
  const basePath = 'M12 0C5.383 0 0 5.383 0 12c0 5.465 3.907 10.192 9 12 5.005-1.835 9-6.556 9-12 0-6.617-5.383-12-12-12zm0 16c-2.21 0-4-1.79-4-4s1.79-4 4-4 4 1.79 4 4-1.79 4-4 4z';

  // For now, return a generic pin path
  return basePath;
}

/**
 * Human-readable label for marker kinds (for accessibility)
 */
export function sourceMarkerLabel(kind: SourceMarkerKind): string {
  switch (kind) {
    case 'human':
      return 'Human Intel';
    case 'aviation':
      return 'Aviation';
    case 'logistics':
      return 'Logistics';
    case 'transport':
      return 'Transport';
    case 'geoSensor':
      return 'Geo Sensor';
    case 'openSource':
      return 'Open Source';
    case 'camera':
      return 'Camera Feed';
    case 'wildfire':
      return 'Wildfire';
    case 'nuclear':
      return 'Nuclear';
    case 'alert':
      return 'Alert';
    case 'saved':
      return 'Saved Point';
    default:
      return 'Data Source';
  }
}
