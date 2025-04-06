import React from 'react';
import { Terminal } from './Terminal';
import { VscChromeClose } from 'react-icons/vsc';
import './TabbedTerminalContainer.css'; // We'll create this CSS file next

interface TabbedTerminalContainerProps {
  activeIds: string[];
  currentTabId: string | null;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
}

export function TabbedTerminalContainer({ 
  activeIds,
  currentTabId,
  onSelectTab,
  onCloseTab,
}: TabbedTerminalContainerProps) {

  if (activeIds.length === 0) {
    return null; // Don't render anything if no terminals are active
  }

  const handleCloseClick = (e: React.MouseEvent, id: string) => {
    e.stopPropagation(); // Prevent tab selection when clicking close
    onCloseTab(id);
  };

  return (
    <div className="tabbed-terminal-overlay">
      <div className="terminal-tab-bar">
        {activeIds.map((id) => (
          <button
            key={id}
            className={`tab-item ${id === currentTabId ? 'active' : ''}`}
            onClick={() => onSelectTab(id)}
          >
            <span>{id}</span>
            <VscChromeClose 
              className="tab-close-btn"
              onClick={(e) => handleCloseClick(e, id)}
            />
          </button>
        ))}
      </div>
      <div className="terminal-content-area">
        {currentTabId && (
          <Terminal
            key={currentTabId} // Ensure Terminal remounts/updates when tab changes
            commandId={currentTabId}
            isVisible={true}
            // We no longer need Terminal's internal onClose prop
          />
        )}
      </div>
    </div>
  );
} 