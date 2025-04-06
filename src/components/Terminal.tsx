import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

interface TerminalProps {
  commandId: string;
  isVisible: boolean;
}

interface CommandInfo {
  id: string;
  is_running: boolean;
  has_error: boolean;
}

export function Terminal({ commandId, isVisible }: TerminalProps) {
  const [output, setOutput] = useState<string[]>([]);
  const [commandInfo, setCommandInfo] = useState<CommandInfo | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const isResizingRef = useRef(false);
  const startHeightRef = useRef(0);
  const startYRef = useRef(0);
  const shouldAutoScrollRef = useRef(true);

  useEffect(() => {
    if (!isVisible) {
      setOutput([]);
      setCommandInfo(null);
      return;
    }

    // Poll for command info
    const infoInterval = setInterval(async () => {
      try {
        const info = await invoke<CommandInfo>("get_command_info", {
          id: commandId,
        });
        setCommandInfo(info);
      } catch (err) {
        console.error('Failed to get command info:', err);
      }
    }, 1000);

    // Poll for command output
    const outputInterval = setInterval(async () => {
      try {
        const lines = await invoke<string[]>("get_command_output", {
          id: commandId,
        });
        setOutput(lines);
        
        // Auto-scroll to bottom if enabled
        if (shouldAutoScrollRef.current && contentRef.current) {
          contentRef.current.scrollTop = contentRef.current.scrollHeight;
        }
      } catch (err) {
        console.error('Failed to get command output:', err);
      }
    }, 100);

    return () => {
      clearInterval(infoInterval);
      clearInterval(outputInterval);
    };
  }, [commandId, isVisible]);

  // Handle manual scroll
  const handleScroll = useCallback(() => {
    if (!contentRef.current) return;
    
    const { scrollTop, scrollHeight, clientHeight } = contentRef.current;
    const isAtBottom = Math.abs(scrollHeight - clientHeight - scrollTop) < 10;
    shouldAutoScrollRef.current = isAtBottom;
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (!overlayRef.current) return;
    
    isResizingRef.current = true;
    startHeightRef.current = overlayRef.current.offsetHeight;
    startYRef.current = e.clientY;
    
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  }, []);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isResizingRef.current || !overlayRef.current) return;

    const delta = startYRef.current - e.clientY;
    const newHeight = Math.max(200, Math.min(window.innerHeight * 0.8, startHeightRef.current + delta));
    overlayRef.current.style.height = `${newHeight}px`;
  }, []);

  const handleMouseUp = useCallback(() => {
    isResizingRef.current = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  useEffect(() => {
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [handleMouseMove, handleMouseUp]);

  if (!isVisible) return null;

  return (
    <div className="terminal-overlay-inner" ref={overlayRef}>
      <div className="terminal-resize-handle" onMouseDown={handleMouseDown} />
      <div className="terminal-window">
        <div className="terminal-header" onMouseDown={handleMouseDown}>
          <h3>
            Terminal - {commandId}
            {commandInfo && (
              <span className={`status-indicator ${commandInfo.is_running ? 'running' : ''} ${commandInfo.has_error ? 'error' : ''}`} />
            )}
          </h3>
        </div>
        <div 
          className="terminal-content" 
          ref={contentRef}
          onScroll={handleScroll}
        >
          {output.map((line, i) => (
            <div 
              key={i} 
              className={`terminal-line ${
                line.toLowerCase().includes('error') || 
                line.toLowerCase().includes('failed') || 
                line.toLowerCase().includes('exception')
                  ? 'error'
                  : ''
              }`}
            >
              {line}
            </div>
          ))}
          {commandInfo && !commandInfo.is_running && (
            <div className={`terminal-line ${commandInfo.has_error ? 'error' : 'success'}`}>
              Process {commandInfo.has_error ? 'failed' : 'completed successfully'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
} 