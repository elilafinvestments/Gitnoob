import { ArrowLeft, Download } from 'lucide-react';

interface NavbarProps {
  showingDownloads: boolean;
  downloadCount: number;
  onBrandClick: () => void;
  onToggleDownloads: () => void;
}

export function Navbar({
  showingDownloads,
  downloadCount,
  onBrandClick,
  onToggleDownloads,
}: NavbarProps) {
  return (
    <header className="gn-topbar">
      <button
        type="button"
        className="gn-wordmark"
        onClick={onBrandClick}
        aria-label="GitNoob Home"
      >
        GitNoob
      </button>

      <button
        type="button"
        className="gn-topbar-btn"
        data-active={showingDownloads}
        onClick={onToggleDownloads}
      >
        {showingDownloads ? (
          <>
            <ArrowLeft size={14} strokeWidth={2} />
            <span>Back</span>
          </>
        ) : (
          <>
            <Download size={14} strokeWidth={1.85} />
            <span>My Downloads</span>
            {downloadCount > 0 && <span className="gn-count-dot">{downloadCount}</span>}
          </>
        )}
      </button>
    </header>
  );
}
