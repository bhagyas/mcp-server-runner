import { useState, useEffect, useRef } from 'react';
import { invoke } from "@tauri-apps/api/core";

interface TerminalProps {
  commandId: string;
  isVisible: boolean;
  onClose: () => void;
}

export function Terminal({ commandId, isVisible, onClose }: TerminalProps) {
  const [output, setOutput] = useState<string[]>([]);
  const terminalRef = useRef<HTMLDivElement>(null);
  
  useEffect(() => {
    if (!isVisible) return;

    const interval = setInterval(async () => {
      try {
        const lines = await invoke<string[]>("get_command_output", { id: commandId });
        setOutput(lines);
        
        // Auto-scroll to bottom
        if (terminalRef.current) {
          terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
        }
      } catch (err) {
        console.error('Failed to fetch output:', err);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [commandId, isVisible]);

  if (!isVisible) return null;

  return (
    <div className="terminal-overlay">
      <div className="terminal-window">
        <div className="terminal-header">
          <h3>Terminal Output - {commandId}</h3>
          <button onClick={onClose}>Close</button>
        </div>
        <div className="terminal-content" ref={terminalRef}>
          {output.map((line, index) => (
            <div key={index} className="terminal-line">
              {line}
            </div>
          ))}
          {output.length === 0 && (
            <div className="terminal-line">Waiting for output...</div>
          )}
        </div>
      </div>
    </div>
  );
} 