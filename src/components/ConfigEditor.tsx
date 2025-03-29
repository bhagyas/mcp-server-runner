import { useState, useEffect } from 'react';
import { invoke } from "@tauri-apps/api/core";
import type { Config } from '../types/mcp';

interface ConfigEditorProps {
  isVisible: boolean;
  onClose: () => void;
  onSave: (config: Config) => void;
}

export function ConfigEditor({ isVisible, onClose, onSave }: ConfigEditorProps) {
  const [configText, setConfigText] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isVisible) {
      loadConfig();
    }
  }, [isVisible]);

  const loadConfig = async () => {
    try {
      const config = await invoke<Config>("load_config", { configPath: null });
      setConfigText(JSON.stringify(config, null, 2));
      setError(null);
    } catch (err) {
      setError(err as string);
    }
  };

  const handleSave = async () => {
    try {
      const config = JSON.parse(configText);
      setError(null);
      await onSave(config);
      onClose();
    } catch (err) {
      if (err instanceof SyntaxError) {
        setError('Invalid JSON format');
      } else {
        setError(err as string);
      }
    }
  };

  if (!isVisible) return null;

  return (
    <div className="terminal-overlay">
      <div className="config-editor">
        <div className="config-editor-header">
          <h3>Edit Configuration</h3>
          <div className="config-editor-actions">
            <button onClick={handleSave}>Save</button>
            <button onClick={onClose}>Close</button>
          </div>
        </div>
        <div className="config-editor-content">
          {error && <div className="error-message">{error}</div>}
          <textarea
            value={configText}
            onChange={(e) => setConfigText(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
          />
        </div>
      </div>
    </div>
  );
} 