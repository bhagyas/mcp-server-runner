import { useState, useEffect, useRef, useCallback, useImperativeHandle, forwardRef } from 'react';
import { invoke } from "@tauri-apps/api/core";
import type { Config } from '../types/mcp';

// Define the shape of the functions we expose via the ref
export interface ConfigEditorRef {
  save: () => Promise<void>;
}

interface ConfigEditorProps {
  isVisible: boolean;
  onClose: () => void;
  onSave: (config: Config) => Promise<void>;
}

// Use forwardRef to pass the ref through
export const ConfigEditor = forwardRef<ConfigEditorRef, ConfigEditorProps>(({ isVisible, onSave }, ref) => {
  const [configText, setConfigText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const textAreaRef = useRef<HTMLTextAreaElement>(null);

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

  // Define handleSave
  const handleSave = useCallback(async () => {
    console.log("Attempting to save config from editor...");
    try {
      const config = JSON.parse(configText);
      setError(null);
      await onSave(config);
      console.log("Config save successful.");
    } catch (err) {
      console.error("Config save failed:", err);
      if (err instanceof SyntaxError) {
        setError('Invalid JSON format');
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
      throw err;
    }
  }, [configText, onSave]);

  // Expose the handleSave function via useImperativeHandle
  useImperativeHandle(ref, () => ({
    save: handleSave
  }));

  if (!isVisible) return null;

  return (
    <>
      {error && (
        <div className="error-message" style={{ marginBottom: '1rem' }}>
          {error}
        </div>
      )}

      <div className="config-editor-content">
        <textarea
          ref={textAreaRef}
          value={configText}
          onChange={(e) => setConfigText(e.target.value)}
          placeholder="Loading configuration..."
          spellCheck={false}
        />
      </div>
    </>
  );
}); 