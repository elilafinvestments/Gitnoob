import { ArrowUp, Check, ChevronDown, Clipboard, Download, Loader2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { TargetOS } from '../types';
import { TARGET_OS_OPTIONS, getOSOption } from '../utils';

interface ComposerBarProps {
  url: string;
  onUrlChange: (val: string) => void;
  selectedOs: TargetOS;
  detectedOs: TargetOS;
  onSelectOs: (os: TargetOS) => void;
  onSubmit: (urlOverride?: string) => void;
  isBusy: boolean;
  variant?: 'hero' | 'dock';
}

export function ComposerBar({
  url,
  onUrlChange,
  selectedOs,
  detectedOs,
  onSelectOs,
  onSubmit,
  isBusy,
  variant = 'hero',
}: ComposerBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const osOption = getOSOption(selectedOs);

  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!url.trim() || isBusy) return;
    onSubmit();
  };

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text && text.trim()) {
        onUrlChange(text.trim());
      }
    } catch {
      // Clipboard access may require manual Cmd/Ctrl+V
    }
  };

  if (variant === 'dock') {
    return (
      <div className="gn-bottom-dock">
        <form className="gn-bottom-bar" onSubmit={handleSubmit}>
          <input
            type="text"
            className="gn-bottom-input"
            placeholder="Paste another GitHub link..."
            value={url}
            onChange={(e) => onUrlChange(e.target.value)}
            disabled={isBusy}
            aria-label="Paste another GitHub link"
            spellCheck={false}
            autoComplete="off"
          />
          {url && !isBusy && (
            <button
              type="button"
              className="gn-icon-btn"
              onClick={() => onUrlChange('')}
              aria-label="Clear link"
            >
              <X size={15} strokeWidth={1.8} />
            </button>
          )}
          <button
            type="submit"
            className="gn-pill-btn gn-pill-primary gn-pill-sm"
            disabled={isBusy || !url.trim()}
            style={{ padding: '8px 14px' }}
          >
            {isBusy ? (
              <Loader2 size={15} strokeWidth={2} className="gn-spin" />
            ) : (
              <>
                <span>Get app</span>
                <ArrowUp size={14} strokeWidth={2.2} />
              </>
            )}
          </button>
        </form>
      </div>
    );
  }

  return (
    <form className="gn-composer" onSubmit={handleSubmit}>
      <div className="gn-composer-input-row">
        <input
          type="text"
          className="gn-composer-input"
          placeholder="Paste any GitHub link (e.g. github.com/owner/repo)..."
          value={url}
          onChange={(e) => onUrlChange(e.target.value)}
          disabled={isBusy}
          aria-label="GitHub repository link"
          spellCheck={false}
          autoComplete="off"
          autoFocus
        />
        {url && !isBusy && (
          <button
            type="button"
            className="gn-icon-btn"
            onClick={() => onUrlChange('')}
            aria-label="Clear link"
          >
            <X size={16} strokeWidth={1.8} />
          </button>
        )}
      </div>

      <div className="gn-composer-footer">
        <div className="gn-composer-left" ref={menuRef}>
          <button
            type="button"
            className="gn-os-pill"
            onClick={() => setMenuOpen((o) => !o)}
            aria-expanded={menuOpen}
            aria-haspopup="listbox"
            disabled={isBusy}
          >
            <span>For {osOption.label}</span>
            <ChevronDown size={14} strokeWidth={1.8} />
          </button>

          {menuOpen && (
            <div className="gn-os-menu" role="listbox" aria-label="Choose your computer">
              {TARGET_OS_OPTIONS.map((opt) => {
                const isSelected = opt.id === selectedOs;
                const isDetected = opt.id === detectedOs;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    className="gn-os-menu-item"
                    data-selected={isSelected}
                    onClick={() => {
                      onSelectOs(opt.id);
                      setMenuOpen(false);
                    }}
                  >
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span>{opt.label}</span>
                        {isDetected && (
                          <span
                            style={{
                              fontSize: '11px',
                              color: '#525252',
                              fontWeight: 400,
                            }}
                          >
                            (this device)
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: '11.5px', color: '#737373', fontWeight: 400 }}>
                        {opt.detail}
                      </div>
                    </div>
                    {isSelected && <Check size={15} strokeWidth={2.2} />}
                  </button>
                );
              })}
            </div>
          )}

          <button
            type="button"
            className="gn-os-pill"
            onClick={handlePaste}
            disabled={isBusy}
            title="Paste link from clipboard"
          >
            <Clipboard size={13} strokeWidth={1.8} />
            <span>Paste</span>
          </button>
        </div>

        <button
          type="submit"
          className="gn-pill-btn gn-pill-primary"
          disabled={isBusy || !url.trim()}
          style={{ padding: '9px 18px', fontSize: '14px' }}
        >
          {isBusy ? (
            <>
              <Loader2 size={15} strokeWidth={2} className="gn-spin" />
              <span>Checking...</span>
            </>
          ) : (
            <>
              <Download size={15} strokeWidth={2} />
              <span>Download</span>
            </>
          )}
        </button>
      </div>
    </form>
  );
}
