import { useEffect, useState } from 'react';

interface AppEmblemProps {
  jobId: string;
  appName: string;
  size: 72 | 40;
}

export function AppEmblem({ jobId, appName, size }: AppEmblemProps) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [jobId]);

  const radius = size >= 64 ? '18px' : '10px';
  const shadow =
    size >= 64
      ? '0 6px 18px rgba(0, 0, 0, 0.10)'
      : '0 2px 8px rgba(0, 0, 0, 0.08)';

  const initials = (appName || 'G')
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || '')
    .join('') || 'G';

  if (failed) {
    return (
      <div
        aria-label={`${appName} emblem`}
        style={{
          width: `${size}px`,
          height: `${size}px`,
          borderRadius: radius,
          background: '#000000',
          color: '#ffffff',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontWeight: 700,
          fontSize: size >= 64 ? '24px' : '14px',
          letterSpacing: '-0.03em',
          boxShadow: shadow,
          flexShrink: 0,
          userSelect: 'none',
        }}
      >
        {initials}
      </div>
    );
  }

  return (
    <img
      src={`/api/jobs/${encodeURIComponent(jobId)}/emblem.svg`}
      alt={`${appName} emblem`}
      width={size}
      height={size}
      onError={() => setFailed(true)}
      style={{
        width: `${size}px`,
        height: `${size}px`,
        borderRadius: radius,
        boxShadow: shadow,
        display: 'block',
        flexShrink: 0,
        objectFit: 'contain',
      }}
    />
  );
}
