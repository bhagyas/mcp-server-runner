import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { join } from '@tauri-apps/api/path';


interface SettingsProps {
  isVisible: boolean;
}

declare global {
  interface Window {
    __TAURI__: {
      invoke: <T>(cmd: string, args?: any) => Promise<T>;
      dialog: {
        open: (options: {
          directory?: boolean;
          multiple?: boolean;
          filters?: Array<{
            name: string;
            extensions: string[];
          }>;
        }) => Promise<string | string[] | null>;
      };
    }
  }
}

export function Settings({ isVisible }: SettingsProps) {
  const [configPath, setConfigPath] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isVisible) {
      loadConfigPath();
    }
  }, [isVisible]);

  const loadConfigPath = async () => {
    try {
      setIsLoading(true);
      setError(null);
      const path = "/mock/path/to/mcp-config.json"; // Placeholder
      setConfigPath(path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  };

  const handleSelectConfigPath = async () => {
    try {
      setError(null);
      let selected = await open({
        directory: false,
        multiple: false,
        filters: [{
          name: 'Configuration',
          extensions: ['json']
        }]
      });

      if (!selected) {
        selected = await open({
          directory: true,
          multiple: false
        });
        if (selected && typeof selected === 'string') {
          selected = selected + "/config.json"; // Basic join for example
        }
      }

      if (selected && typeof selected === 'string') {
        setConfigPath(selected);
        console.log("New config path selected (but not saved):", selected);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (!isVisible) return null;

  return (
    <div className="settings-content">
      <div className="settings-section">
        <h2>Configuration File</h2>
        <p className="section-description">
          Choose where to store your MCP Server Runner configuration file.
        </p>

        {error && (
          <div className="error-message">
            {error}
          </div>
        )}

        <div className="settings-item">
          <div className="settings-item-content">
            <div className="settings-item-header">
              <h3>Configuration Path</h3>
              <p className="settings-item-description">
                The location where your server configurations are stored.
              </p>
            </div>
            <div className="settings-item-value">
              {isLoading ? (
                <span className="loading">Loading...</span>
              ) : (
                <code className="config-path">{configPath}</code>
              )}
            </div>
          </div>
          <button 
            className="secondary-button"
            onClick={handleSelectConfigPath}
            disabled={isLoading}
          >
            Change Location
          </button>
        </div>
      </div>
    </div>
  );
} 