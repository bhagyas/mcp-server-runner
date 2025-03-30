import { useState, useEffect, useRef } from "react";
import { invoke } from '@tauri-apps/api/core';
import { confirm } from '@tauri-apps/plugin-dialog';
import type { MCPCommand, AddMCPCommand, Config, MCPServerConfig } from "./types/mcp";
import { AddMCPCommand as AddMCPCommandForm } from "./components/AddMCPCommand";
import { Terminal } from "./components/Terminal";
import { ConfigEditor, ConfigEditorRef } from "./components/ConfigEditor";
import { Settings } from "./components/Settings";
import { VscServer, VscSettingsGear, VscAdd, VscJson, VscTerminal, VscTrash, VscEdit, VscDebugStart, VscDebugStop, VscSave, VscInfo } from "react-icons/vsc";
import "./App.css";

interface CommandInfo {
  id: string;
  is_running: boolean;
  has_error: boolean;
}

type ActiveView = 'servers' | 'settings' | 'config';

// Approx height of the terminal based on CSS (40vh)
// A more robust solution would measure the actual element or pass height up
const TERMINAL_APPROX_HEIGHT = '40vh'; 

// Timeout for graceful stop before prompting for force kill (in milliseconds)
const GRACEFUL_STOP_TIMEOUT = 5000; 

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
  // New state for commands attempting graceful stop
  const [stoppingCommandIds, setStoppingCommandIds] = useState<Set<string>>(new Set());
  // Ref to store timeout IDs for graceful stop
  const stopTimersRef = useRef<Record<string, number>>({});

  useEffect(() => {
    loadConfig();

    // --- Cleanup Timers on Unmount ---
    return () => {
      console.log("App unmounting, clearing stop timers.");
      Object.values(stopTimersRef.current).forEach(clearTimeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps 
  }, []); // Run only on mount

  // Effect for polling running command statuses
  useEffect(() => {
    const intervalId = setInterval(async () => {
      const runningCommandIds = Object.entries(commandInfo)
        .filter(([_, info]) => info.is_running)
        .map(([id, _]) => id);
      
      // Also include commands that are in the 'stopping' phase in the poll
      const idsToPoll = new Set([...runningCommandIds, ...stoppingCommandIds]);

      if (idsToPoll.size === 0) {
        return; // No need to poll if nothing is running or stopping
      }
      
      console.log(`Polling status for commands: ${[...idsToPoll].join(', ')}`);

      const updates: Record<string, CommandInfo> = {};
      let stateChanged = false;

      for (const id of idsToPoll) {
        try {
          const latestInfo = await invoke<CommandInfo>("get_command_info", { id });
          updates[id] = latestInfo;

          // --- Check if a stopping command has finished --- 
          if (!latestInfo.is_running && stoppingCommandIds.has(id)) {
            console.log(`Graceful stop for ${id} confirmed by poll. Clearing timer.`);
            clearTimeout(stopTimersRef.current[id]);
            delete stopTimersRef.current[id];
            setStoppingCommandIds(prev => {
              const newSet = new Set(prev);
              newSet.delete(id);
              return newSet;
            });
            stateChanged = true; // Ensure state update happens
          }
          // --- End stopping command check ---

          // Check if the running status actually changed compared to current state
          if (commandInfo[id]?.is_running !== latestInfo.is_running) {
              console.log(`Command ${id} status changed: Running=${latestInfo.is_running}, Error=${latestInfo.has_error}`);
            stateChanged = true;
          }
        } catch (err) {
          // Handle cases where the command might have been removed or backend error
          console.error(`Polling failed for command ${id}:`, err);
          // If polling fails for a command we think is running or stopping, mark it as stopped/error
          if(commandInfo[id]?.is_running || stoppingCommandIds.has(id)) { 
             updates[id] = { ...(commandInfo[id] || { id, is_running: false, has_error: false }), is_running: false, has_error: true };
             stateChanged = true;
             // Also clean up stopping state if polling fails
             if (stoppingCommandIds.has(id)) {
               console.warn(`Polling failed for stopping command ${id}. Clearing timer and stopping state.`);
               clearTimeout(stopTimersRef.current[id]);
               delete stopTimersRef.current[id];
               setStoppingCommandIds(prev => {
                 const newSet = new Set(prev);
                 newSet.delete(id);
                 return newSet;
               });
             }
          }
        }
      }

      // Update state only if any relevant command status changed
      if (stateChanged) {
          console.log("Updating commandInfo and commands state due to poll results.");
        setCommandInfo(prevInfo => ({ // Update commandInfo first
          ...prevInfo,
          ...updates,
        }));

        setCommands(prevCmds => // Then update commands based on fresh info
          prevCmds.map(cmd => {
            if (updates[cmd.id]) {
              return { ...cmd, isRunning: updates[cmd.id].is_running };
            }
            return cmd;
          })
        );
      }

    }, 2000); // Poll every 2 seconds

    // Cleanup interval on component unmount
    return () => clearInterval(intervalId);

  // Include stoppingCommandIds in dependency array so polling loop restarts if it changes
  }, [commandInfo, stoppingCommandIds]); 

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
      setStoppingCommandIds(new Set()); // Reset stopping state on load
      Object.values(stopTimersRef.current).forEach(clearTimeout); // Clear any lingering timers
      stopTimersRef.current = {};
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
      // Make sure it's not running or stopping before edit
      if (commandInfo[editingCommand.id]?.is_running || stoppingCommandIds.has(editingCommand.id)) {
        setError(`Cannot edit server '${editingCommand.id}' while it is running or stopping.`);
        return;
      }
      await invoke<Config>("remove_server", { name: editingCommand.id });
      await invoke<Config>("add_server", {
        name: editedCommand.name, // Use potentially new name from edit form
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
    // Prevent toggle if already stopping gracefully
    if (stoppingCommandIds.has(cmdId)) {
      console.warn(`Command ${cmdId} is already in the process of stopping gracefully. Ignoring toggle.`);
      return;
    }

    try {
      setError(null);
      const currentBackendInfo = commandInfo[cmdId];
      // Base 'isCurrentlyRunning' on commandInfo if available, otherwise fallback to cmd.isRunning
      const isCurrentlyRunning = currentBackendInfo ? currentBackendInfo.is_running : cmd.isRunning;
      
      let backendResponseInfo: CommandInfo;
      let wasStartAttempt = false; // Flag to know if we tried to start

      if (!isCurrentlyRunning) {
        console.log(`Attempting to start command ${cmdId}`);
        wasStartAttempt = true;
        backendResponseInfo = await invoke<CommandInfo>("start_command", { id: cmdId });
        console.log(`Start command ${cmdId} backend response:`, backendResponseInfo);
      } else { // Attempt graceful stop
        console.log(`Attempting graceful stop for command ${cmdId}`);
        // Set stopping state *before* calling backend
        setStoppingCommandIds(prev => new Set(prev).add(cmdId));
        
        backendResponseInfo = await invoke<CommandInfo>("stop_command", { id: cmdId }); // Call graceful stop
        console.log(`Graceful stop command ${cmdId} backend response:`, backendResponseInfo);

        // --- Start Timeout for Force Kill Prompt --- 
        const timerId = setTimeout(async () => {
          console.log(`Graceful stop timeout reached for ${cmdId}. Checking status...`);
          // Check FRESH status directly via get_command_info after timeout
          // Avoid relying on potentially stale commandInfo state here
          let stillRunning = false;
          try {
            const freshInfo = await invoke<CommandInfo>("get_command_info", { id: cmdId });
            stillRunning = freshInfo.is_running;
            console.log(`Timeout check for ${cmdId}: Fresh status is_running=${stillRunning}`);
          } catch (fetchErr) {
            console.error(`Timeout check: Failed to get fresh info for ${cmdId}:`, fetchErr);
            // Assume it might still be running or in an error state if fetch fails
            stillRunning = true; 
          }

          // Only prompt if it's still considered running AND still in the stopping set
          if (stillRunning && stoppingCommandIds.has(cmdId)) { 
            console.log(`Command ${cmdId} still running after timeout. Prompting user.`);
            const userConfirmedForceKill = await confirm(
              `Process "${cmdId}" did not stop gracefully after ${GRACEFUL_STOP_TIMEOUT / 1000} seconds. Force kill?`,
              { title: 'Force Kill Process?', okLabel: 'Force Kill', cancelLabel: 'Cancel' }
            );

            if (userConfirmedForceKill) {
              console.log(`User confirmed force kill for ${cmdId}. Invoking force_kill_command.`);
              try {
                await invoke<CommandInfo>("force_kill_command", { id: cmdId });
              } catch (forceKillErr) {
                const errorMsg = forceKillErr instanceof Error ? forceKillErr.message : String(forceKillErr);
                console.error(`Force kill command ${cmdId} failed:`, errorMsg);
                setError(`Failed to force kill ${cmdId}: ${errorMsg}`);
              }
            } else {
              console.log(`User cancelled force kill for ${cmdId}.`);
            }
          } else {
            console.log(`Timeout check: Command ${cmdId} already stopped or removed from stopping state. No prompt needed.`);
          }
          
          // --- Cleanup after timeout logic --- 
          delete stopTimersRef.current[cmdId];
          setStoppingCommandIds(prev => {
            const newSet = new Set(prev);
            newSet.delete(cmdId);
            return newSet;
          });
          console.log(`Removed ${cmdId} from stopping state after timeout logic.`);
          // --- End Cleanup --- 

        }, GRACEFUL_STOP_TIMEOUT);
        
        stopTimersRef.current[cmdId] = timerId;
        console.log(`Started graceful stop timer ${timerId} for ${cmdId}`);
        // --- End Timeout --- 
      }

      // Update state based *only* on the backend response immediately after toggle
      // For stop, backendResponseInfo still shows is_running=true, which is correct initially
      setCommandInfo(prev => ({ 
          ...prev, 
          [cmdId]: backendResponseInfo 
      }));
      // Only update the main command list's isRunning if it was a start attempt
      if (wasStartAttempt) {
        setCommands(prevCmds => prevCmds.map(c => 
            c.id === cmdId ? { ...c, isRunning: backendResponseInfo.is_running } : c
        ));
      }

      // --- Auto-open terminal on successful start --- (Keep existing logic)
      if (wasStartAttempt && backendResponseInfo.is_running) {
        console.log(`Command ${cmdId} started successfully, opening terminal.`);
        setSelectedCommand(cmdId);
      }
      // --- End auto-open --- 

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`Toggle command ${cmdId} failed:`, errorMsg);
      setError(errorMsg);
      // If toggle failed, ensure it's removed from stopping state if it was added
      if (stoppingCommandIds.has(cmdId)) {
         console.warn(`Toggle failed for ${cmdId}, clearing timer and stopping state.`);
         clearTimeout(stopTimersRef.current[cmdId]);
         delete stopTimersRef.current[cmdId];
         setStoppingCommandIds(prev => {
           const newSet = new Set(prev);
           newSet.delete(cmdId);
           return newSet;
         });
      }
    }
  };

  const handleRemoveCommand = async (idToRemove: string) => {
    console.log("Attempting to remove command:", idToRemove);
    // Prevent removal if running OR in the process of stopping
    if (commandInfo[idToRemove]?.is_running || stoppingCommandIds.has(idToRemove)) {
      setError(`Cannot remove server '${idToRemove}' while it is running or stopping.`);
      setOpenMenuId(null); // Close menu
      return;
    }

    // --- Confirmation Dialog --- 
    const userConfirmed = await confirm(
      `Are you sure you want to remove the server "${idToRemove}"? This action cannot be undone.`,
      { title: 'Remove Server?', okLabel: 'Confirm', cancelLabel: 'Cancel' }
    );

    if (!userConfirmed) {
      console.log("User cancelled server removal.");
      setOpenMenuId(null);
      return;
    }
    // --- End Confirmation --- 

    console.log("User confirmed removal for command:", idToRemove);
    try {
      setError(null);
      await invoke<Config>("remove_server", { name: idToRemove });
      await loadConfig(); // Reload config to reflect removal
      if (selectedCommand === idToRemove) {
        setSelectedCommand(null); // Close terminal if it was open for this command
      }
      setOpenMenuId(null); // Ensure menu is closed after action
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
        // Handle error appropriately in UI if needed
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

      <main 
        className="main-content"
        style={{
          paddingBottom: selectedCommand ? `calc(${TERMINAL_APPROX_HEIGHT} + 2rem)` : '2rem',
          // Add small extra padding (e.g., 2rem) to the terminal height
        }}
      >
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
        <div className="view-content-area">
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
                  const currentInfo = commandInfo[cmd.id] || { id: cmd.id, is_running: false, has_error: false };
                  const isRunning = currentInfo.is_running;
                  const hasError = currentInfo.has_error;
                  const isStopping = stoppingCommandIds.has(cmd.id);
                  // Disable edit/remove if running OR stopping
                  const isMenuDisabled = isRunning || isStopping;
                  
                  return (
                    <div key={cmd.id} className={`command-item ${hasError && !isRunning ? 'error-state' : ''} ${isStopping ? 'stopping-state' : ''}`}>
                      <div className="command-header">
                        <div className="command-name">
                          {/* Status indicator reflects backend state (is_running), use stopping-state class for visual cue */}
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
                            disabled={isMenuDisabled} // Disable menu if running or stopping
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
                                disabled={isMenuDisabled} // Disable edit
                              >
                                <VscEdit className="menu-icon" />
                                Edit
                              </button>
                              <button 
                                className="delete"
                                onClick={() => handleRemoveCommand(cmd.id)}
                                disabled={isMenuDisabled} // Disable remove
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
                          <div className="info-row tooltip-container">
                            <span className="info-label">Port</span>
                            <span className="info-value">
                              {cmd.port}
                              <VscInfo className="info-icon tooltip-trigger" />
                            </span>
                            <span className="tooltip-text">
                              For reference only. Does not affect executed command.
                            </span>
                          </div>
                        )}
                        {Object.entries(cmd.env || {}).length > 0 && (
                          <div className="info-row">
                            <span className="info-label">Environment</span>
                            <div className="info-value">
                              {Object.entries(cmd.env || {}).map(([key, value]) => (
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
                          className={`action-button ${isRunning ? (isStopping ? 'stopping' : 'stop') : 'start'}`}
                          onClick={() => handleToggleCommand(cmd)}
                          disabled={isStopping} // Disable toggle button while stopping
                        >
                          {isStopping ? (
                            <>
                              {/* Optional: Add a spinner icon here later */}
                              <VscDebugStop className="button-icon" />
                              Stopping...
                            </>
                          ) : isRunning ? (
                            <>
                              <VscDebugStop className="button-icon" />
                              Stop
                            </>
                          ) : (
                            <>
                              <VscDebugStart className="button-icon" />
                              Start
                            </>
                          )}
                        </button>
                        {(isRunning || isStopping) && ( // Show terminal button if running OR stopping
                          <button 
                            className="action-button secondary"
                            onClick={() => setSelectedCommand(cmd.id)}
                            disabled={isStopping} // Optionally disable terminal button during stop attempt?
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
