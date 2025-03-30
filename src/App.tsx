import { useState, useEffect, useRef } from "react";
import { invoke } from '@tauri-apps/api/core';
import type { MCPCommand, AddMCPCommand, Config, MCPServerConfig } from "./types/mcp";
import { AddMCPCommand as AddMCPCommandForm } from "./components/AddMCPCommand";
import { Terminal } from "./components/Terminal";
import { ConfigEditor, ConfigEditorRef } from "./components/ConfigEditor";
import { Settings } from "./components/Settings";
import { VscServer, VscSettingsGear, VscAdd, VscJson, VscTerminal, VscTrash, VscEdit, VscDebugStart, VscDebugStop, VscSave } from "react-icons/vsc";
import "./App.css";

interface CommandInfo {
  id: string;
  is_running: boolean;
  has_error: boolean;
}

type ActiveView = 'servers' | 'settings' | 'config';

function App() {
  const [commands, setCommands] = useState<MCPCommand[]>([]);
  const [commandInfo, setCommandInfo] = useState<Record<string, CommandInfo>>({});
  const [error, setError] = useState<string | null>(null);
  const [selectedCommand, setSelectedCommand] = useState<string | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [editingCommand, setEditingCommand] = useState<MCPCommand | null>(null);
  const [isAddCommandFormOpen, setIsAddCommandFormOpen] = useState(false);
  const [activeView, setActiveView] = useState<ActiveView>('servers');
  const configEditorRef = useRef<ConfigEditorRef>(null);

  useEffect(() => {
    loadConfig();
  }, []);

  // Effect for polling running command statuses
  useEffect(() => {
    const intervalId = setInterval(async () => {
      const runningCommandIds = Object.entries(commandInfo)
        .filter(([_, info]) => info.is_running)
        .map(([id, _]) => id);

      if (runningCommandIds.length === 0) {
        return; // No need to poll if nothing is marked as running
      }
      
      console.log(`Polling status for running commands: ${runningCommandIds.join(', ')}`);

      const updates: Record<string, CommandInfo> = {};
      let stateChanged = false;

      for (const id of runningCommandIds) {
        try {
          const latestInfo = await invoke<CommandInfo>("get_command_info", { id });
          updates[id] = latestInfo;
          // Check if the running status actually changed compared to current state
          if (commandInfo[id]?.is_running !== latestInfo.is_running) {
              console.log(`Command ${id} status changed: Running=${latestInfo.is_running}, Error=${latestInfo.has_error}`);
            stateChanged = true;
          }
        } catch (err) {
          // Handle cases where the command might have been removed or backend error
          console.error(`Polling failed for command ${id}:`, err);
          // Optionally mark as stopped/error in UI if fetch fails consistently
          if(commandInfo[id]?.is_running) { // If it was running before the error
             updates[id] = { ...commandInfo[id], is_running: false, has_error: true };
             stateChanged = true;
          }
        }
      }

      // Update state only if any relevant command status changed
      if (stateChanged) {
          console.log("Updating commandInfo and commands state due to poll results.");
        setCommandInfo(prevInfo => ({
          ...prevInfo,
          ...updates,
        }));

        // Update the isRunning flag in the main commands list as well
        setCommands(prevCmds => 
          prevCmds.map(cmd => {
            if (updates[cmd.id]) {
              // If we have fresh info for this command from the poll
              return { ...cmd, isRunning: updates[cmd.id].is_running };
            }
            return cmd; // Otherwise, keep the existing command state
          })
        );
      }

    }, 2000); // Poll every 2 seconds

    // Cleanup interval on component unmount
    return () => clearInterval(intervalId);

  }, [commandInfo]); // Rerun effect if commandInfo changes (e.g., after start/stop)

  const loadConfig = async () => {
    try {
      setError(null);
      const config = await invoke<Config>("load_config", { configPath: null });
      const initialInfo: Record<string, CommandInfo> = {};
      const loadedCommands = Object.entries(config.mcpServers).map(([id, server]) => {
        initialInfo[id] = { id, is_running: false, has_error: false };
        return {
          id,
          name: id,
          command: (server as MCPServerConfig).command,
          args: (server as MCPServerConfig).args,
          env: (server as MCPServerConfig).env,
          port: (server as MCPServerConfig).port,
          isRunning: false,
        };
      });
      setCommands(loadedCommands);
      setCommandInfo(initialInfo);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleAddCommand = async (newCommand: AddMCPCommand) => {
    console.log("Adding command:", newCommand);
    try {
      setError(null);
      await invoke<Config>("add_server", {
        name: newCommand.name,
        command: newCommand.command,
        args: newCommand.args,
        env: newCommand.env,
        port: newCommand.port,
      });
      await loadConfig();
      setIsAddCommandFormOpen(false);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error("Add command failed:", errorMsg);
      setError(errorMsg);
    }
  };

  const handleEditCommand = async (editedCommand: MCPCommand) => {
    console.log("Editing command:", editedCommand);
    if (!editingCommand) return;

    try {
      setError(null);
      await invoke<Config>("remove_server", { name: editingCommand.id });
      await invoke<Config>("add_server", {
        name: editedCommand.name,
        command: editedCommand.command,
        args: editedCommand.args,
        env: editedCommand.env,
        port: editedCommand.port,
      });
      await loadConfig();
      setIsAddCommandFormOpen(false);
      setEditingCommand(null);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error("Edit command failed:", errorMsg);
      setError(errorMsg);
    }
  };

  const handleToggleCommand = async (cmd: MCPCommand) => {
    const cmdId = cmd.id;
    console.log(`Toggling command ${cmdId}... Current running state in UI:`, cmd.isRunning);
    try {
      setError(null);
      const currentBackendInfo = commandInfo[cmdId];
      const isCurrentlyRunning = currentBackendInfo ? currentBackendInfo.is_running : cmd.isRunning;
      
      let backendResponseInfo: CommandInfo;
      let wasStartAttempt = false; // Flag to know if we tried to start

      if (!isCurrentlyRunning) {
        console.log(`Attempting to start command ${cmdId}`);
        wasStartAttempt = true;
        backendResponseInfo = await invoke<CommandInfo>("start_command", { id: cmdId });
        console.log(`Start command ${cmdId} backend response:`, backendResponseInfo);
      } else {
        console.log(`Attempting to stop command ${cmdId}`);
        backendResponseInfo = await invoke<CommandInfo>("stop_command", { id: cmdId });
         console.log(`Stop command ${cmdId} backend response:`, backendResponseInfo);
      }

      // Update state based *only* on the backend response immediately after toggle
      setCommandInfo(prev => ({ 
          ...prev, 
          [cmdId]: backendResponseInfo 
      }));
      setCommands(prevCmds => prevCmds.map(c => 
          c.id === cmdId ? { ...c, isRunning: backendResponseInfo.is_running } : c
      ));

      // --- Auto-open terminal on successful start ---
      if (wasStartAttempt && backendResponseInfo.is_running) {
        console.log(`Command ${cmdId} started successfully, opening terminal.`);
        setSelectedCommand(cmdId);
      }
      // --- End auto-open --- 

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`Toggle command ${cmdId} failed:`, errorMsg);
      setError(errorMsg);
    }
  };

  const handleRemoveCommand = async (idToRemove: string) => {
    console.log("Removing command:", idToRemove);
    if (commandInfo[idToRemove]?.is_running) {
      setError("Cannot remove a running server.");
      return;
    }
    try {
      setError(null);
      await invoke<Config>("remove_server", { name: idToRemove });
      await loadConfig();
      if (selectedCommand === idToRemove) {
        setSelectedCommand(null);
      }
      setOpenMenuId(null);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error("Remove command failed:", errorMsg);
      setError(errorMsg);
    }
  };

  const handleSaveConfig = async (config: Config) => {
    console.log("Saving config via onSave prop...");
    try {
      setError(null);
      await invoke<void>("save_config", { config });
      await loadConfig();
      console.log("Config saved successfully via onSave prop.");
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error("Save config failed:", errorMsg);
      setError(errorMsg);
      throw err;
    }
  };

  const handleFormSubmit = (formData: AddMCPCommand | MCPCommand) => {
    if (editingCommand) {
      handleEditCommand({ 
        ...formData,
        id: editingCommand.id,
        isRunning: editingCommand.isRunning
       });
    } else {
      handleAddCommand(formData as AddMCPCommand);
    }
  };

  const handleFormClose = () => {
    setIsAddCommandFormOpen(false);
    setEditingCommand(null);
  };

  // Determine header content based on active view
  let headerTitle = "Servers";
  let headerSubtitle = "Manage and monitor your MCP servers";
  if (activeView === 'config') {
    headerTitle = "Configuration";
    headerSubtitle = "Edit the raw mcp-config.json file";
  } else if (activeView === 'settings') {
    headerTitle = "Settings";
    headerSubtitle = "Configure application settings";
  }

  const triggerConfigSave = async () => {
    if (configEditorRef.current) {
      try {
        await configEditorRef.current.save();
      } catch (error) {
        console.error("Save triggered from App failed.");
      }
    }
  };

  return (
    <div className="container">
      <aside className="sidebar">
        <h2>MCP Server Runner</h2>
        <nav className="nav-items">
          <div 
            className={`nav-item ${activeView === 'servers' ? 'active' : ''}`}
            onClick={() => setActiveView('servers')}
          >
            <VscServer className="nav-icon" />
            Servers
          </div>
          <div 
            className={`nav-item ${activeView === 'config' ? 'active' : ''}`}
            onClick={() => setActiveView('config')}
          >
            <VscJson className="nav-icon" />
            Configuration
          </div>
          <div 
            className={`nav-item ${activeView === 'settings' ? 'active' : ''}`}
            onClick={() => setActiveView('settings')}
          >
            <VscSettingsGear className="nav-icon" />
            Settings
          </div>
        </nav>
      </aside>

      <main className="main-content">
        {/* --- Shared Header --- */}
        <div className="header">
          <div>
            <h1>{headerTitle}</h1>
            <p className="subtitle">{headerSubtitle}</p>
          </div>
          <div className="header-actions">
            {activeView === 'servers' && (
               <button className="primary-button" onClick={() => setIsAddCommandFormOpen(true)}>
                 <VscAdd className="button-icon" />
                 Add Server
               </button>
             )}
             {activeView === 'config' && (
               <button className="primary-button" onClick={triggerConfigSave}>
                 <VscSave className="button-icon" />
                 Save Config
               </button>
             )}
          </div>
        </div>

        {/* --- Error Display --- */}
        {error && (
          <div className="error-message">
            Error: {error}
          </div>
        )}

        {/* --- View Specific Content --- */}
        <div className="view-content">
          {activeView === 'servers' && (
            <>
              {/* Stats container specific to Servers view */}
              <div className="stats-container">
                <div className="stat-item">
                  <h3>Total Servers</h3>
                  <div className="stat-value">{commands.length}</div>
                </div>
                <div className="stat-item">
                  <h3>Running Servers</h3>
                  {/* Use commandInfo length for running count for better accuracy */}
                  <div className="stat-value">
                     {Object.values(commandInfo).filter(info => info.is_running).length}
                  </div>
                </div>
              </div>

              {/* Command list specific to Servers view */}
              <div className="commands-list">
                {commands.map((cmd) => {
                  const currentInfo = commandInfo[cmd.id] || { is_running: false, has_error: false };
                  const isRunning = currentInfo.is_running;
                  const hasError = currentInfo.has_error;
                  const isDisabled = isRunning;
                  
                  return (
                    <div key={cmd.id} className={`command-item ${hasError && !isRunning ? 'error-state' : ''}`}>
                      <div className="command-header">
                        <div className="command-name">
                          <span className={`status-indicator ${isRunning ? 'running' : ''} ${hasError ? 'error' : ''}`} />
                          {cmd.name}
                        </div>
                        <div className="menu-container">
                          <button 
                            className="menu-button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setOpenMenuId(openMenuId === cmd.id ? null : cmd.id);
                            }}
                            disabled={isRunning}
                          >
                            <div className="menu-dots">⋮</div>
                          </button>
                          {openMenuId === cmd.id && (
                            <div className="dropdown-menu">
                              <button 
                                onClick={() => {
                                  setEditingCommand(cmd);
                                  setIsAddCommandFormOpen(true);
                                  setOpenMenuId(null);
                                }}
                                disabled={isDisabled}
                              >
                                <VscEdit className="menu-icon" />
                                Edit
                              </button>
                              <button 
                                className="delete"
                                onClick={() => handleRemoveCommand(cmd.id)}
                                disabled={isDisabled}
                              >
                                <VscTrash className="menu-icon" />
                                Remove
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="command-info">
                        <div className="info-row">
                          <span className="info-label">Command</span>
                          <span className="info-value">{cmd.command} {cmd.args.join(' ')}</span>
                        </div>
                        {cmd.port && (
                          <div className="info-row">
                            <span className="info-label">Port</span>
                            <span className="info-value">{cmd.port}</span>
                          </div>
                        )}
                        {Object.entries(cmd.env || {}).length > 0 && (
                          <div className="info-row">
                            <span className="info-label">Environment</span>
                            <div className="info-value">
                              {Object.entries(cmd.env || {}).map(([key, value], i) => (
                                <div key={key}>
                                  {key}={value}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                      <div className="command-actions">
                        <button 
                          className={`action-button ${isRunning ? 'stop' : 'start'}`}
                          onClick={() => handleToggleCommand(cmd)}
                        >
                          {isRunning ? <VscDebugStop className="button-icon" /> : <VscDebugStart className="button-icon" />}
                          {isRunning ? 'Stop' : 'Start'}
                        </button>
                        {isRunning && (
                          <button 
                            className="action-button secondary"
                            onClick={() => setSelectedCommand(cmd.id)}
                          >
                            <VscTerminal className="button-icon" />
                            Terminal
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {activeView === 'settings' && (
            <Settings isVisible={true} /> // Assuming Settings doesn't need header
          )}
          
          {activeView === 'config' && (
            <ConfigEditor 
              ref={configEditorRef}
              isVisible={true}
              onClose={() => setActiveView('servers')} // Config editor close goes back to servers
              onSave={handleSaveConfig}
            /> // Assuming ConfigEditor doesn't need header
          )}
        </div> 
      </main>

      {/* Terminal and AddCommandForm overlays remain outside main content */}
      {selectedCommand && (
        <Terminal
          commandId={selectedCommand}
          isVisible={true}
          onClose={() => setSelectedCommand(null)}
        />
      )}

      {isAddCommandFormOpen && (
        <AddMCPCommandForm
          isVisible={true}
          onClose={handleFormClose}
          onSubmit={handleFormSubmit}
          editCommand={editingCommand}
        />
      )}
    </div>
  );
}

export default App;
