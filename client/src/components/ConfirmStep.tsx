import { ArrowLeft, Download, Eye, EyeOff, KeyRound, Loader2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { RepoAnalysis, TargetOS } from '../types';
import { formatBytes, getFriendlyOsPossessive, normalizeReleaseAssets } from '../utils';

interface ConfirmStepProps {
  analysis: RepoAnalysis;
  selectedOs: TargetOS;
  envValues: Record<string, string>;
  onEnvChange: (key: string, val: string) => void;
  onContinuePackage: () => void;
  onCancel: () => void;
  isStarting: boolean;
}

export function ConfirmStep({
  analysis,
  selectedOs,
  envValues,
  onEnvChange,
  onContinuePackage,
  onCancel,
  isStarting,
}: ConfirmStepProps) {
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const releaseAssets = useMemo(() => normalizeReleaseAssets(analysis.releases), [analysis.releases]);
  const isReleaseOnly = analysis.packagingStrategy === 'release-only';
  const envVars = Array.isArray(analysis.envVars) ? analysis.envVars : [];

  return (
    <div className="gn-card" style={{ maxWidth: '580px' }}>
      <div style={{ marginBottom: '18px' }}>
        <button type="button" className="gn-pill-btn gn-pill-sm" onClick={onCancel}>
          <ArrowLeft size={14} strokeWidth={1.8} />
          <span>Back</span>
        </button>
      </div>

      <h2
        style={{
          margin: '0 0 8px',
          fontSize: '26px',
          fontWeight: 600,
          letterSpacing: '-0.025em',
          lineHeight: 1.2,
        }}
      >
        {analysis.name}
      </h2>

      <p style={{ margin: '0 0 22px', fontSize: '15px', color: '#525252', lineHeight: 1.55 }}>
        {analysis.plainEnglish?.summary ||
          analysis.description ||
          'Ready to get this project onto your computer.'}
        {analysis.packagingStrategy === 'react-component'
          ? ' GitNoob will automatically wrap this React component into a ready-to-use app.'
          : ''}
      </p>

      {isReleaseOnly && releaseAssets.length > 0 && (
        <div style={{ marginBottom: '22px' }}>
          <div style={{ fontSize: '13.5px', fontWeight: 600, marginBottom: '10px' }}>
            Official ready-to-run downloads from the author
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {releaseAssets.slice(0, 6).map((item, idx) => (
              <div
                key={`${item.asset.name}-${idx}`}
                style={{
                  border: '1px solid #e5e5e5',
                  borderRadius: '14px',
                  padding: '12px 14px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '12px',
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: '13.5px',
                      fontWeight: 500,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {item.asset.name}
                  </div>
                  <div style={{ fontSize: '12px', color: '#737373' }}>
                    {item.tagName}
                    {item.asset.size ? ` · ${formatBytes(item.asset.size)}` : ''}
                  </div>
                </div>
                <a
                  href={item.downloadUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="gn-pill-btn gn-pill-primary gn-pill-sm"
                >
                  <Download size={13} strokeWidth={2} />
                  <span>Download</span>
                </a>
              </div>
            ))}
          </div>
        </div>
      )}

      {envVars.length > 0 && (
        <div style={{ marginBottom: '24px' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '7px',
              fontSize: '14px',
              fontWeight: 600,
              marginBottom: '6px',
            }}
          >
            <KeyRound size={15} strokeWidth={1.85} />
            <span>This app asks for a few settings first</span>
          </div>
          <p style={{ margin: '0 0 14px', fontSize: '13.5px', color: '#525252' }}>
            Add them below if you have them—we&apos;ll bundle them right in so you don&apos;t have
            to edit any config files. Or skip and fill them in later.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {envVars.map((env) => {
              const isSecret = /key|secret|token|pass|auth/i.test(env.key);
              const isShown = Boolean(revealed[env.key]);
              return (
                <div key={env.key}>
                  <label
                    htmlFor={`cfg-${env.key}`}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      fontSize: '13px',
                      fontWeight: 500,
                      marginBottom: '4px',
                    }}
                  >
                    <span className="gn-mono" style={{ fontSize: '12.5px' }}>
                      {env.key}
                    </span>
                    {env.required && (
                      <span style={{ fontSize: '11.5px', color: '#525252' }}>Required</span>
                    )}
                  </label>
                  {env.description && (
                    <div style={{ fontSize: '12.5px', color: '#737373', marginBottom: '5px' }}>
                      {env.description}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <input
                      id={`cfg-${env.key}`}
                      type={isSecret && !isShown ? 'password' : 'text'}
                      className="gn-input"
                      placeholder={env.defaultValue || `Enter ${env.key}`}
                      value={envValues[env.key] ?? ''}
                      onChange={(e) => onEnvChange(env.key, e.target.value)}
                    />
                    {isSecret && (
                      <button
                        type="button"
                        className="gn-pill-btn gn-pill-sm"
                        onClick={() =>
                          setRevealed((prev) => ({ ...prev, [env.key]: !prev[env.key] }))
                        }
                        aria-label={isShown ? 'Hide value' : 'Show value'}
                      >
                        {isShown ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {analysis.warnings && analysis.warnings.length > 0 && (
        <div
          style={{
            marginBottom: '20px',
            padding: '12px 14px',
            borderRadius: '14px',
            background: '#f7f7f8',
            fontSize: '13px',
            color: '#525252',
            lineHeight: 1.5,
          }}
        >
          {analysis.warnings[0]}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <button
          type="button"
          className={`gn-pill-btn ${isReleaseOnly && releaseAssets.length > 0 ? '' : 'gn-pill-primary'}`}
          style={{ flex: '1 1 220px', padding: '13px 22px' }}
          disabled={isStarting}
          onClick={onContinuePackage}
        >
          {isStarting ? (
            <>
              <Loader2 size={16} strokeWidth={2} className="gn-spin" />
              <span>Starting...</span>
            </>
          ) : (
            <span>
              {isReleaseOnly && releaseAssets.length > 0
                ? `Or build from source for ${getFriendlyOsPossessive(selectedOs)}`
                : `Prepare download for ${getFriendlyOsPossessive(selectedOs)}`}
            </span>
          )}
        </button>
      </div>
    </div>
  );
}
