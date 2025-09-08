import React, { useEffect, useState } from "react";
import { invoke } from '@tauri-apps/api/core';

// Placeholder for secure storage. Replace with secure storage in production.
const SMITHERY_API_KEY = "ae725119-e863-44a3-96fb-705536e12035";

interface ServerSummary {
  qualifiedName: string;
  displayName: string;
  description: string;
  homepage: string;
  useCount: string;
  isDeployed: boolean;
  createdAt: string;
}

interface DiscoverServersProps {
  onAddServer: (server: any) => void;
}

export const DiscoverServers: React.FC<DiscoverServersProps> = ({ onAddServer }) => {
  const [servers, setServers] = useState<ServerSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState<string>(SMITHERY_API_KEY);
  const [showApiKeyPrompt, setShowApiKeyPrompt] = useState(apiKey === "REPLACE_ME_WITH_YOUR_API_KEY");
  const [pendingConfigFields, setPendingConfigFields] = useState<any[]>([]);
  const [pendingConfigValues, setPendingConfigValues] = useState<Record<string, any>>({});
  const [pendingServerDetails, setPendingServerDetails] = useState<any>(null);
  const [showConfigPrompt, setShowConfigPrompt] = useState(false);
  const [showManualConfigPrompt, setShowManualConfigPrompt] = useState(false);
  const [manualConfig, setManualConfig] = useState({ command: '', args: '', env: '', port: '' });
  const [manualConfigSchema, setManualConfigSchema] = useState<any>(null);
  const [manualServerDetails, setManualServerDetails] = useState<any>(null);
  const [detailsCache, setDetailsCache] = useState<Record<string, any>>({});
  const [searchInput, setSearchInput] = useState("");
  const [activeSearchTerm, setActiveSearchTerm] = useState<string | null>(null);

  useEffect(() => {
    if (!apiKey || apiKey === "REPLACE_ME_WITH_YOUR_API_KEY") return;
    setLoading(true);
    setError(null);
    invoke('fetch_smithery_servers', { apiKey, searchTerm: activeSearchTerm })
      .then(async (data: any) => {
        const allServers = data.servers || [];
        const filtered: ServerSummary[] = [];
        const detailCache: Record<string, any> = {};
        const concurrency = 5;
        let idx = 0;
        async function processNext() {
          if (idx >= allServers.length) return;
          const server = allServers[idx++];
          try {
            const details: any = await invoke('fetch_smithery_server_details', {
              apiKey,
              qualifiedName: server.qualifiedName,
            });
            detailCache[server.qualifiedName] = details;
            if (Array.isArray(details.connections) && details.connections.some((c: any) => c.type === 'stdio')) {
              filtered.push(server);
            }
          } catch (e) {
            // Ignore errors for individual servers
          }
          await processNext();
        }
        await Promise.all(Array(concurrency).fill(0).map(processNext));
        setServers(filtered);
        setDetailsCache(prevCache => ({ ...prevCache, ...detailCache }));
      })
      .catch((err) => {
        setError((err && err.toString()) || "Failed to fetch servers");
      })
      .finally(() => setLoading(false));
  }, [apiKey, activeSearchTerm]);

  const handleApiKeyChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setApiKey(e.target.value);
  };

  const handleApiKeySave = () => {
    setShowApiKeyPrompt(false);
    // In production, store securely
    // For now, just in state
  };

  const handleAdd = async (server: ServerSummary) => {
    setLoading(true);
    setError(null);
    try {
      const details: any = await invoke('fetch_smithery_server_details', {
        apiKey,
        qualifiedName: server.qualifiedName,
      });
      // Find stdio connection
      const stdioConn = Array.isArray(details.connections)
        ? details.connections.find((c: any) => c.type === 'stdio')
        : null;
      if (!stdioConn) {
        setError('This server does not provide a stdio connection and cannot be added.');
        setLoading(false);
        return;
      }
      // Detect required config fields without defaults
      let missingFields: any[] = [];
      if (stdioConn.configSchema && stdioConn.configSchema.required && stdioConn.configSchema.properties) {
        for (const field of stdioConn.configSchema.required) {
          const prop = stdioConn.configSchema.properties[field];
          if (prop && typeof prop === 'object' && Object.prototype.hasOwnProperty.call(prop, 'default') === false) {
            missingFields.push({
              name: field,
              ...prop
            });
          }
        }
      }
      if (missingFields.length > 0) {
        setPendingConfigFields(missingFields);
        setPendingConfigValues({});
        setPendingServerDetails({ details, stdioConn });
        setShowConfigPrompt(true);
        setLoading(false);
        return;
      }
      // No missing fields, build config with defaults
      const configObj: Record<string, any> = {};
      if (stdioConn.configSchema && stdioConn.configSchema.properties) {
        for (const [key, prop] of Object.entries(stdioConn.configSchema.properties)) {
          if (prop && typeof prop === 'object' && Object.prototype.hasOwnProperty.call(prop, 'default')) {
            configObj[key] = (prop as any).default;
          }
        }
      }
      addStdioServer(details, stdioConn, configObj);
    } catch (err: any) {
      setError(err.message || "Failed to add server");
      setLoading(false);
    }
  };

  // Helper to build and add the server using config values
  const addStdioServer = (details: any, stdioConn: any, configObj: Record<string, any>) => {
    let command: string = '';
    let args: string[] = [];
    let env: Record<string, string> = {};
    let port: number | undefined = undefined;

    // 1. Prioritize values from configObj (user input/prompted) or top-level server details
    command = configObj.command || details.command || '';
    // Ensure args from configObj/details are arrays if they exist
    args = Array.isArray(configObj.args) ? configObj.args : (Array.isArray(details.args) ? details.args : []);
    env = (typeof configObj.env === 'object' && configObj.env !== null) ? configObj.env : ((typeof details.env === 'object' && details.env !== null) ? details.env : {});
    port = typeof configObj.port === 'number' ? configObj.port : (typeof details.port === 'number' ? details.port : undefined);

    // 2. Fallback to configSchema.properties.<field>.default if still not found
    if (stdioConn.configSchema && stdioConn.configSchema.properties) {
      const props = stdioConn.configSchema.properties;
      if (!command && props.command && typeof props.command === 'object' && Object.prototype.hasOwnProperty.call(props.command, 'default') && typeof props.command.default === 'string') {
        command = props.command.default;
      }
      if (args.length === 0 && props.args && typeof props.args === 'object' && Object.prototype.hasOwnProperty.call(props.args, 'default') && Array.isArray(props.args.default)) {
        args = props.args.default;
      }
      if (Object.keys(env).length === 0 && props.env && typeof props.env === 'object' && Object.prototype.hasOwnProperty.call(props.env, 'default') && typeof props.env.default === 'object') {
        env = props.env.default as Record<string, string>; // Added type assertion
      }
      if (port === undefined && props.port && typeof props.port === 'object' && Object.prototype.hasOwnProperty.call(props.port, 'default') && typeof props.port.default === 'number') {
        port = props.port.default;
      }
    }

    if (!command) {
      // Show manual config modal, pre-fill with any determined values
      setManualConfig({
        command: command || '', // Will be empty here
        args: args.join(' ') || '',
        env: Object.keys(env).length > 0 ? JSON.stringify(env, null, 2) : '', // Pretty print JSON
        port: port?.toString() || ''
      });
      setManualConfigSchema(stdioConn.configSchema);
      setManualServerDetails(details); // Pass full details for context
      setShowManualConfigPrompt(true);
      setLoading(false); // Ensure loading is stopped
      return;
    }

    const config = {
      name: details.displayName || details.qualifiedName,
      command,
      args,
      env,
      port,
    };
    onAddServer(config);
    setLoading(false); // Ensure loading is stopped
  };

  // Handler for config prompt submit
  const handleConfigPromptSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!pendingServerDetails) return;
    // Merge user input with defaults
    const configObj: Record<string, any> = { ...pendingConfigValues };
    const { stdioConn, details } = pendingServerDetails;
    if (stdioConn.configSchema && stdioConn.configSchema.properties) {
      for (const [key, prop] of Object.entries(stdioConn.configSchema.properties)) {
        if (configObj[key] === undefined && prop && typeof prop === 'object' && Object.prototype.hasOwnProperty.call(prop, 'default')) {
          configObj[key] = (prop as any).default;
        }
      }
    }
    addStdioServer(details, stdioConn, configObj);
    setShowConfigPrompt(false);
    setPendingConfigFields([]);
    setPendingConfigValues({});
    setPendingServerDetails(null);
  };

  // Handler for config prompt input change
  const handleConfigInputChange = (field: string, value: any) => {
    setPendingConfigValues(prev => ({ ...prev, [field]: value }));
  };

  // Handler for manual config submit
  const handleManualConfigSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualServerDetails) return;
    let argsArr = manualConfig.args.split(' ').filter((a) => a.length > 0);
    let envObj: Record<string, string> = {};
    try {
      envObj = manualConfig.env ? JSON.parse(manualConfig.env) : {};
    } catch {
      setError('Env must be a valid JSON object');
      return;
    }
    const config = {
      name: manualServerDetails.displayName || manualServerDetails.qualifiedName,
      command: manualConfig.command,
      args: argsArr,
      env: envObj,
      port: manualConfig.port ? parseInt(manualConfig.port, 10) : undefined,
    };
    onAddServer(config);
    setShowManualConfigPrompt(false);
    setManualConfig({ command: '', args: '', env: '', port: '' });
    setManualConfigSchema(null);
    setManualServerDetails(null);
  };

  // Handler for manual config input change
  const handleManualConfigInputChange = (field: string, value: any) => {
    setManualConfig((prev) => ({ ...prev, [field]: value }));
  };

  const handleSearchInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchInput(e.target.value);
  };

  const handleSearchSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    setActiveSearchTerm(searchInput.trim() === "" ? null : searchInput.trim());
  };

  if (showApiKeyPrompt) {
    return (
      <div className="discover-api-key-prompt">
        <h3>Enter your Smithery API Key</h3>
        <input
          type="text"
          value={apiKey}
          onChange={handleApiKeyChange}
          placeholder="Paste your Smithery API key here"
          style={{ width: "100%", marginBottom: 8 }}
        />
        <button onClick={handleApiKeySave} disabled={!apiKey || apiKey === "REPLACE_ME_WITH_YOUR_API_KEY"}>
          Save API Key
        </button>
        <p style={{ color: "#888", marginTop: 8 }}>
          You can create an API key at <a href="https://smithery.ai/docs/use/registry" target="_blank" rel="noopener noreferrer">Smithery Registry</a>.
        </p>
      </div>
    );
  }

  return (
    <div className="discover-servers-view">
      <h3>Popular MCP Servers</h3>
      {/* Search Bar */}
      <form onSubmit={handleSearchSubmit} style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.5rem' }}>
        <input
          type="text"
          value={searchInput}
          onChange={handleSearchInputChange}
          placeholder="Search servers (e.g., python, minecraft)..."
          style={{ flexGrow: 1, padding: '0.5rem 0.75rem', borderRadius: '6px', border: '1px solid var(--border-color)' }}
        />
        <button type="submit" className="primary-button">
          Search
        </button>
        {activeSearchTerm && (
          <button 
            type="button" 
            className="secondary-button" 
            onClick={() => { setSearchInput(""); setActiveSearchTerm(null); }}
          >
            Clear
          </button>
        )}
      </form>

      {loading && <div>Loading...</div>}
      {error && <div className="error-message">Error: {error}</div>}
      <div className="commands-list">
        {servers.map((server) => (
          <div key={server.qualifiedName} className="command-item">
            <div className="command-header">
              <div className="command-name">
                <span className={`status-indicator ${server.isDeployed ? 'running' : ''}`} title={server.isDeployed ? 'Deployed' : 'Not deployed'} />
                {server.displayName}
                {detailsCache[server.qualifiedName] && Array.isArray(detailsCache[server.qualifiedName].connections) && (
                  <span className="server-type-tags-container" style={{ display: 'inline-flex', gap: '0.3rem', marginLeft: '0.5rem', alignItems: 'center' }}>
                    {detailsCache[server.qualifiedName].connections.map((conn: any, i: number) => (
                      <span key={i} className={`server-type-tag type-${conn.type?.toLowerCase()}`}>{conn.type}</span>
                    ))}
                  </span>
                )}
              </div>
              {/* Wrapper for Homepage and GitHub buttons */}
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                {detailsCache[server.qualifiedName]?.repositoryUrl && (
                  <a
                    href={detailsCache[server.qualifiedName].repositoryUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="secondary-button"
                    title="Open GitHub Repository"
                  >
                    {/* Optional: <VscGithubInverted className="button-icon" /> */}
                    GitHub
                  </a>
                )}
                <a 
                  href={server.homepage} 
                  target="_blank" 
                  rel="noopener noreferrer" 
                  className="secondary-button"
                  title="Open Homepage"
                >
                  Homepage
                </a>
              </div>
            </div>
            <div className="command-info">
              <div className="info-row">
                <span className="info-label">Qualified Name</span>
                <span className="info-value">{server.qualifiedName}</span>
              </div>
              <div className="info-row">
                <span className="info-label">Uses</span>
                <span className="info-value">{server.useCount}</span>
              </div>
              <div className="info-row">
                <span className="info-label">Created</span>
                <span className="info-value">{new Date(server.createdAt).toLocaleDateString()}</span>
              </div>
            </div>
            <div className="command-info">
              <div className="info-row">
                <span className="info-label">Description</span>
                <span className="info-value">{server.description}</span>
              </div>
            </div>

            {/* STDIN/STDOUT Config Preview */}
            {detailsCache[server.qualifiedName]?.connections?.filter((c: any) => c.type === 'stdio').map((stdioConn: any, connIdx: number) => {
              let previewCommand: string | undefined;
              let previewArgs: string[] | undefined;
              let previewEnv: Record<string, string> | undefined;
              let otherConfigurableProps: Record<string, any> = {};

              if (stdioConn.configSchema && stdioConn.configSchema.properties) {
                const props = stdioConn.configSchema.properties;
                if (props.command && typeof props.command === 'object' && Object.prototype.hasOwnProperty.call(props.command, 'default')) {
                  previewCommand = props.command.default;
                } else if (props.command) {
                  otherConfigurableProps.command = props.command;
                }
                if (props.args && typeof props.args === 'object' && Object.prototype.hasOwnProperty.call(props.args, 'default') && Array.isArray(props.args.default)) {
                  previewArgs = props.args.default;
                } else if (props.args) {
                  otherConfigurableProps.args = props.args;
                }
                if (props.env && typeof props.env === 'object' && Object.prototype.hasOwnProperty.call(props.env, 'default') && typeof props.env.default === 'object') {
                  previewEnv = props.env.default;
                } else if (props.env) {
                  otherConfigurableProps.env = props.env;
                }
                // Collect other properties
                for (const [key, prop] of Object.entries(props)) {
                  if (key !== 'command' && key !== 'args' && key !== 'env') {
                    otherConfigurableProps[key] = prop;
                  }
                }
              }

              return (
                <div key={connIdx} className="command-info" style={{ marginTop: '0.5rem', paddingTop: '0.5rem', borderTop: '1px solid var(--border-color)' }}>
                  <h4 style={{ margin: '0 0 0.75rem 0', fontSize: '0.9em', color: 'var(--text-secondary)' }}>
                    STDIO Configuration Preview
                    {stdioConn.name && <span style={{fontWeight: 'normal'}}> ({stdioConn.name})</span>}
                  </h4>
                  {previewCommand !== undefined && (
                    <div className="info-row" style={{fontSize: '0.9em'}}>
                      <span className="info-label" style={{minWidth: '100px'}}>Command</span>
                      <span className="info-value">{JSON.stringify(previewCommand)} <i style={{color: 'var(--text-secondary)'}}>(default)</i></span>
                    </div>
                  )}
                  {previewArgs !== undefined && (
                    <div className="info-row" style={{fontSize: '0.9em'}}>
                      <span className="info-label" style={{minWidth: '100px'}}>Arguments</span>
                      <span className="info-value">{JSON.stringify(previewArgs)} <i style={{color: 'var(--text-secondary)'}}>(default)</i></span>
                    </div>
                  )}
                  {previewEnv !== undefined && Object.keys(previewEnv).length > 0 && (
                    <div className="info-row" style={{fontSize: '0.9em'}}>
                      <span className="info-label" style={{minWidth: '100px'}}>Environment</span>
                      <span className="info-value">{JSON.stringify(previewEnv)} <i style={{color: 'var(--text-secondary)'}}>(default)</i></span>
                    </div>
                  )}
                  {Object.keys(otherConfigurableProps).length > 0 && (
                    <div style={{marginTop: '0.5rem'}}>
                      <h5 style={{ margin: '0 0 0.25rem 0', fontSize: '0.85em', color: 'var(--text-secondary)' }}>User-Configurable Options:</h5>
                      {Object.entries(otherConfigurableProps).map(([key, prop]: [string, any]) => {
                        const isRequired = stdioConn.configSchema?.required?.includes(key);
                        const hasDefault = typeof prop === 'object' && prop !== null && Object.prototype.hasOwnProperty.call(prop, 'default');
                        return (
                          <div key={key} className="info-row" style={{fontSize: '0.85em'}}>
                            <span className="info-label" style={{minWidth: '100px'}}>{prop.title || key}</span>
                            <span className="info-value">
                              {hasDefault ? (
                                <>{JSON.stringify(prop.default)} {isRequired && <i style={{color: 'var(--text-secondary)'}}>(default)</i>}</>
                              ) : isRequired ? (
                                <i style={{color: 'var(--text-secondary)'}}>(required, will be prompted)</i>
                              ) : (
                                <i style={{color: 'var(--text-secondary)'}}>(optional)</i>
                              )}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {previewCommand === undefined && previewArgs === undefined && Object.keys(previewEnv || {}).length === 0 && Object.keys(otherConfigurableProps).length === 0 && (
                     stdioConn.configSchema ? (
                      <p style={{fontSize: '0.9em', color: 'var(--text-secondary)', margin: 0}}><i>No specific command/args/env defaults found; other properties may be prompted.</i></p>
                    ) : (
                      <p style={{fontSize: '0.9em', color: 'var(--text-secondary)', margin: 0}}><i>No config schema defined for this STDIN/STDOUT connection.</i></p>
                    )
                  )}
                   <p style={{fontSize: '0.75em', color: 'var(--text-secondary)', marginTop: '0.5rem', fontStyle:'italic'}}>Note: Final values may be determined by the server's internal logic.</p>
                </div>
              );
            })}

            <div className="command-actions">
              <button onClick={() => handleAdd(server)} disabled={loading} className="action-button start">
                Add
              </button>
            </div>
          </div>
        ))}
      </div>
      {showConfigPrompt && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h3>Required Configuration</h3>
            <form onSubmit={handleConfigPromptSubmit}>
              {pendingConfigFields.map((field) => (
                <div className="form-group" key={field.name}>
                  <label htmlFor={field.name}>{field.title || field.name}</label>
                  <input
                    id={field.name}
                    type={field.type === 'number' ? 'number' : 'text'}
                    value={pendingConfigValues[field.name] || ''}
                    onChange={e => handleConfigInputChange(field.name, e.target.value)}
                    required
                    placeholder={field.description || ''}
                  />
                </div>
              ))}
              <div className="form-actions">
                <button type="submit" className="primary-button">Add Server</button>
                <button type="button" className="secondary-button" onClick={() => setShowConfigPrompt(false)}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}
      {showManualConfigPrompt && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h3>Manual Server Configuration</h3>
            <p>Could not determine the command for this stdio server. Please enter the details manually.</p>
            <form onSubmit={handleManualConfigSubmit}>
              <div className="form-group">
                <label htmlFor="manual-command">Command</label>
                <input
                  id="manual-command"
                  type="text"
                  value={manualConfig.command}
                  onChange={e => handleManualConfigInputChange('command', e.target.value)}
                  required
                  placeholder="e.g. python"
                />
              </div>
              <div className="form-group">
                <label htmlFor="manual-args">Arguments (space separated)</label>
                <input
                  id="manual-args"
                  type="text"
                  value={manualConfig.args}
                  onChange={e => handleManualConfigInputChange('args', e.target.value)}
                  placeholder="e.g. -m my_module --flag"
                />
              </div>
              <div className="form-group">
                <label htmlFor="manual-env">Environment Variables (JSON)</label>
                <input
                  id="manual-env"
                  type="text"
                  value={manualConfig.env}
                  onChange={e => handleManualConfigInputChange('env', e.target.value)}
                  placeholder='e.g. {"API_KEY": "value"}'
                />
              </div>
              <div className="form-group">
                <label htmlFor="manual-port">Port (optional)</label>
                <input
                  id="manual-port"
                  type="number"
                  value={manualConfig.port}
                  onChange={e => handleManualConfigInputChange('port', e.target.value)}
                  placeholder="e.g. 3000"
                  min="1"
                  max="65535"
                />
              </div>
              <div className="form-actions">
                <button type="submit" className="primary-button">Add Server</button>
                <button type="button" className="secondary-button" onClick={() => setShowManualConfigPrompt(false)}>Cancel</button>
              </div>
            </form>
            <div style={{ marginTop: 16 }}>
              <h4>Config Schema (for reference)</h4>
              <pre style={{ background: '#222', color: '#fff', padding: 12, borderRadius: 6, fontSize: 12, overflowX: 'auto' }}>
                {JSON.stringify(manualConfigSchema, null, 2)}
              </pre>
            </div>
          </div>
        </div>
      )}
      <div style={{ marginTop: 16, color: '#888', fontSize: 12 }}>
        <b>Note:</b> The API key is stored in memory only for this session. Please update it in the settings for secure storage.
      </div>
    </div>
  );
}; 