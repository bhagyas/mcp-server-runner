import { useState, useEffect } from 'react';
import { invoke } from "@tauri-apps/api/core";
import type { Config } from '../types/mcp';

interface ConfigEditorProps {
  isVisible: boolean;
  onClose: () => void;
  onSave: (config: Config) => void;
}

export function ConfigEditor({ isVisible, onSave }: ConfigEditorProps) {
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
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSave = async () => {
    try {
      const config = JSON.parse(configText);
      setError(null);
      await onSave(config);
    } catch (err) {
      if (err instanceof SyntaxError) {
        setError('Invalid JSON format');
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  };

  if (!isVisible) return null;

  return (
    <div className="config-editor-view">
      <div className="header">
        <div>
          <h1>Configuration</h1>
          <p className="subtitle">Edit your MCP Server Runner configuration</p>
        </div>
        <div className="header-actions">
          <button className="primary-button" onClick={handleSave}>
            Save Changes
          </button>
        </div>
      </div>

      {error && (
        <div className="error-message">
          {error}
        </div>
      )}

      <div className="config-editor-content">
        <textarea
          value={configText}
          onChange={(e) => setConfigText(e.target.value)}
          placeholder="Loading configuration..."
          spellCheck={false}
        />
      </div>
    </div>
  );
} 