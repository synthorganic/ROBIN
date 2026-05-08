import {
  Camera,
  ExternalLink,
  FileText,
  Link2,
  MapPin,
  NotebookPen,
} from 'lucide-react';
import type { MapAsset } from './api';

interface MapAssetInspectorProps {
  asset: MapAsset | null;
  currentSessionId?: string | null;
}

type PreviewKind = 'iframe' | 'video' | 'image' | 'source-data' | 'none';

interface PreviewDescriptor {
  kind: PreviewKind;
  src?: string;
  note?: string;
}

const VIDEO_FILE_RE = /\.(mp4|webm|ogg|mov|m4v)(?:$|[?#])/i;
const IMAGE_FILE_RE = /\.(png|jpe?g|gif|webp|svg)(?:$|[?#])/i;
const PDF_FILE_RE = /\.pdf(?:$|[?#])/i;
const WINDOWS_PATH_RE = /^[a-zA-Z]:\\/;

function sourceIcon(type: MapAsset['type']) {
  switch (type) {
    case 'document':
      return <FileText size={16} />;
    case 'video':
      return <Camera size={16} />;
    case 'note':
      return <NotebookPen size={16} />;
    default:
      return <Link2 size={16} />;
  }
}

function embedVideoUrl(url: string) {
  const youtubeMatch = url.match(
    /(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{6,})/i,
  );
  if (youtubeMatch) {
    return `https://www.youtube.com/embed/${youtubeMatch[1]}`;
  }

  const vimeoMatch = url.match(/vimeo\.com\/(\d+)/i);
  if (vimeoMatch) {
    return `https://player.vimeo.com/video/${vimeoMatch[1]}`;
  }

  return null;
}

function describePreview(asset: MapAsset): PreviewDescriptor {
  if (asset.live) {
    return {
      kind: 'source-data',
      note: 'Live source records are rendered from parsed feed data. Open the source only when you need the provider page.',
    };
  }

  const sourceUrl = asset.sourceUrl.trim();
  if (!sourceUrl) {
    return { kind: 'none', note: 'Attach a URL or local route to preview this asset here.' };
  }

  if (WINDOWS_PATH_RE.test(sourceUrl)) {
    return {
      kind: 'none',
      note: 'Windows filesystem paths cannot be embedded directly in the browser. Use a served URL or open the source externally.',
    };
  }

  const embeddedVideo = embedVideoUrl(sourceUrl);
  if (embeddedVideo) {
    return { kind: 'iframe', src: embeddedVideo };
  }

  if (VIDEO_FILE_RE.test(sourceUrl)) {
    return { kind: 'video', src: sourceUrl };
  }

  if (IMAGE_FILE_RE.test(sourceUrl) || (asset.thumbnailUrl && IMAGE_FILE_RE.test(asset.thumbnailUrl))) {
    return { kind: 'image', src: IMAGE_FILE_RE.test(sourceUrl) ? sourceUrl : asset.thumbnailUrl };
  }

  if (PDF_FILE_RE.test(sourceUrl)) {
    return { kind: 'iframe', src: sourceUrl };
  }

  if (asset.type === 'video' || asset.type === 'document' || asset.type === 'link') {
    return {
      kind: 'iframe',
      src: sourceUrl,
      note: 'Some sites block embedding. Use Open Source if the panel stays blank.',
    };
  }

  return { kind: 'none', note: asset.notes || 'This asset does not expose a browser-previewable source.' };
}

function locationLabel(asset: MapAsset) {
  return `Lat ${asset.lat.toFixed(4)} / Lng ${asset.lng.toFixed(4)}`;
}

function formatObservedAt(value: string | undefined) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString([], {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function sourceDataRows(asset: MapAsset) {
  return [
    ['Source', asset.sourceName || asset.sourceId || 'Operator'],
    ['Status', asset.status || 'Unspecified'],
    ['Severity', asset.severity || 'Unspecified'],
    ['Confidence', asset.confidence || 'Unspecified'],
    ['Observed', formatObservedAt(asset.observedAt) || 'Unspecified'],
    ['Location', locationLabel(asset)],
  ].filter(([, value]) => value);
}

export default function MapAssetInspector({ asset, currentSessionId }: MapAssetInspectorProps) {
  if (!asset) {
    return (
      <div className="ops-asset-shell">
        <div className="ops-helper">
          Select a map asset to inspect its linked document, feed, or note details.
        </div>
      </div>
    );
  }

  const preview = describePreview(asset);
  const linkedToCurrent = currentSessionId && asset.linkedSessionId === currentSessionId;

  return (
    <div className="ops-asset-shell">
      <div className="ops-asset-head">
        <div className="ops-asset-title-group">
          <span className="ops-badge">
            {sourceIcon(asset.type)}
            {asset.type}
          </span>
          {asset.sourceName ? <span className="ops-badge">{asset.sourceName}</span> : null}
          {asset.severity ? <span className="ops-badge">{asset.severity}</span> : null}
          {asset.confidence ? <span className="ops-badge">{asset.confidence} confidence</span> : null}
          {asset.status ? <span className="ops-badge">{asset.status}</span> : null}
          {linkedToCurrent ? <span className="ops-badge">linked to current agent</span> : null}
        </div>
        <h4>{asset.title}</h4>
        <div className="ops-asset-meta-line">
          <span><MapPin size={14} /> {locationLabel(asset)}</span>
          {formatObservedAt(asset.observedAt) ? <span>{formatObservedAt(asset.observedAt)}</span> : null}
          {asset.linkedSessionId ? <span><Link2 size={14} /> {asset.linkedSessionId}</span> : null}
        </div>
      </div>

      {asset.sourceUrl ? (
        <div className="ops-asset-actions">
          <a className="ops-button ghost" href={asset.sourceUrl} target="_blank" rel="noreferrer">
            <ExternalLink size={16} /> Open Source
          </a>
        </div>
      ) : null}

      <div className="ops-asset-preview">
        {preview.kind === 'iframe' && preview.src ? (
          <iframe
            title={`${asset.title} preview`}
            className="ops-asset-iframe"
            src={preview.src}
            loading="lazy"
            allow="autoplay; fullscreen; encrypted-media"
            allowFullScreen
          />
        ) : null}

        {preview.kind === 'video' && preview.src ? (
          <video className="ops-asset-video" controls preload="metadata">
            <source src={preview.src} />
          </video>
        ) : null}

        {preview.kind === 'image' && preview.src ? (
          <img className="ops-asset-image" src={preview.src} alt={asset.title} loading="lazy" />
        ) : null}

        {preview.kind === 'source-data' ? (
          <div className="ops-source-data-preview">
            <div className="ops-source-data-head">
              <span>{asset.sourceName || 'Live Source'}</span>
              {asset.observedAt ? <time>{formatObservedAt(asset.observedAt)}</time> : null}
            </div>
            <div className="ops-source-data-title">{asset.title}</div>
            <div className="ops-source-data-grid">
              {sourceDataRows(asset).map(([label, value]) => (
                <div key={label} className="ops-source-data-row">
                  <span>{label}</span>
                  <strong>{value}</strong>
                </div>
              ))}
            </div>
            {asset.notes ? <p>{asset.notes}</p> : null}
          </div>
        ) : null}

        {preview.kind === 'none' ? (
          <div className="ops-asset-placeholder">
            <div className="ops-helper">{preview.note}</div>
          </div>
        ) : null}
      </div>

      {preview.note && preview.kind !== 'none' ? (
        <div className="ops-note">{preview.note}</div>
      ) : null}

      {asset.notes ? (
        <div className="ops-asset-section">
          <div className="ops-asset-section-title">Analysis Notes</div>
          <div className="ops-note">{asset.notes}</div>
        </div>
      ) : null}

      {asset.tags.length ? (
        <div className="ops-asset-section">
          <div className="ops-asset-section-title">Tags</div>
          <div className="ops-tag-row">
            {asset.tags.map((tag) => (
              <span key={tag} className="ops-tag">{tag}</span>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
