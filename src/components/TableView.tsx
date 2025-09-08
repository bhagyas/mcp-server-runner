import React, { useRef, useEffect } from 'react';
import { VscDebugStart, VscDebugStop, VscEdit, VscTrash, VscTerminal, VscStopCircle } from 'react-icons/vsc';
import type { MCPCommand } from '../types/mcp';
import ReactDOM from 'react-dom';

interface TableViewProps {
  commands: MCPCommand[];
  commandInfo: Record<string, any>;
  onToggleCommand: (cmd: MCPCommand) => void;
  onEditCommand: (cmd: MCPCommand) => void;
  onRemoveCommand: (id: string) => void;
  onForceKill: (id: string) => void;
  onOpenTerminal: (id: string) => void;
  openMenuId: string | null;
  setOpenMenuId: (id: string | null) => void;
  isActionLocked: (status: any) => boolean;
}

// Helper for portal dropdown
const DropdownPortal: React.FC<{ anchorRef: React.RefObject<HTMLElement>, children: React.ReactNode, onClose: () => void }> = ({ anchorRef, children, onClose }) => {
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        anchorRef.current &&
        !anchorRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose, anchorRef]);

  const anchor = anchorRef.current;
  let style: React.CSSProperties = { position: 'absolute', zIndex: 9999, minWidth: 120, pointerEvents: 'auto' };
  if (anchor) {
    const rect = anchor.getBoundingClientRect();
    style.top = rect.bottom + window.scrollY + 4;
    style.left = rect.right + window.scrollX - 140; // right-align
  }
  return ReactDOM.createPortal(
    <div ref={dropdownRef} className="dropdown-menu" style={style}>{children}</div>,
    document.body
  );
};

export const TableView: React.FC<TableViewProps> = ({
  commands,
  commandInfo,
  onToggleCommand,
  onEditCommand,
  onRemoveCommand,
  onForceKill,
  onOpenTerminal,
  openMenuId,
  setOpenMenuId,
  isActionLocked,
}) => {
  const menuButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  return (
    <div className="table-view-container">
      <table className="commands-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Status</th>
            <th>Command</th>
            <th>Port</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {commands.map((cmd) => {
            const currentInfo = commandInfo[cmd.id];
            const status = currentInfo?.status ?? { state: 'Idle' };
            const hasError = status.state === 'Error' || (status.state === 'Finished' && !status.success);
            const isLocked = isActionLocked(status);
            let buttonContent: React.ReactNode = null;
            let isButtonDisabled = false;
            let showForceKillButton = false;
            switch (status.state) {
              case 'Idle':
              case 'Finished':
              case 'Error':
                buttonContent = <><VscDebugStart className="button-icon" /> Start</>;
                break;
              case 'Running':
                buttonContent = <><VscDebugStop className="button-icon" /> Stop</>;
                break;
              case 'Starting':
                buttonContent = <>Starting...</>;
                isButtonDisabled = true;
                break;
              case 'Stopping':
                buttonContent = <>Stopping...</>;
                isButtonDisabled = true;
                showForceKillButton = true;
                break;
              case 'Killing':
                buttonContent = <>Killing...</>;
                isButtonDisabled = true;
                break;
            }
            return (
              <tr key={cmd.id} className={`${hasError ? 'error-state' : ''} ${isLocked ? 'locked-state' : ''}`}>
                <td>
                  <span className={`status-indicator state-${status.state.toLowerCase()} ${hasError ? 'error' : ''}`} />
                  {cmd.name}
                </td>
                <td>{status.state}{status.state === 'Finished' && status.code !== undefined ? ` (${status.code})` : ''}</td>
                <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cmd.command} {cmd.args.join(' ')}</td>
                <td>{cmd.port ?? ''}</td>
                <td style={{ position: 'relative' }}>
                  <div className="table-actions-group">
                    <button
                      className={`action-button table-action${status.state === 'Running' ? ' stop' : ' start'}`}
                      onClick={() => onToggleCommand(cmd)}
                      disabled={isButtonDisabled}
                    >
                      {buttonContent}
                    </button>
                    {showForceKillButton && (
                      <button
                        className="action-button stop force-kill"
                        onClick={() => onForceKill(cmd.id)}
                        title="Force Kill Process"
                      >
                        <VscStopCircle className="button-icon" />
                        Force Kill
                      </button>
                    )}
                    {(status.state === 'Running' || status.state === 'Starting' || status.state === 'Stopping' || status.state === 'Killing') && (
                      <button
                        className="action-button secondary"
                        onClick={() => onOpenTerminal(cmd.id)}
                      >
                        <VscTerminal className="button-icon" />
                        Terminal
                      </button>
                    )}
                    <button
                      className="action-button secondary dropdown-action-btn"
                      ref={el => (menuButtonRefs.current[cmd.id] = el)}
                      onClick={() => setOpenMenuId(openMenuId === cmd.id ? null : cmd.id)}
                      disabled={isLocked}
                    >
                      ⋮
                    </button>
                  </div>
                  {openMenuId === cmd.id && menuButtonRefs.current[cmd.id] && (
                    <DropdownPortal anchorRef={{ current: menuButtonRefs.current[cmd.id] }} onClose={() => setOpenMenuId(null)}>
                      <button onClick={() => { onEditCommand(cmd); setOpenMenuId(null); }} disabled={isLocked}><VscEdit /> Edit</button>
                      <button onClick={() => onRemoveCommand(cmd.id)} disabled={isLocked} className="delete"><VscTrash /> Remove</button>
                    </DropdownPortal>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}; 