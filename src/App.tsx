import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from '@tauri-apps/api/core';
import { confirm } from '@tauri-apps/plugin-dialog';
import type { MCPCommand, AddMCPCommand, Config, MCPServerConfig } from "./types/mcp";
import { AddMCPCommand as AddMCPCommandForm } from "./components/AddMCPCommand";
import { TabbedTerminalContainer } from "./components/TabbedTerminalContainer";
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
  const [activeTerminalIds, setActiveTerminalIds] = useState<string[]>([]);
  const [currentTerminalTabId, setCurrentTerminalTabId] = useState<string | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [editingCommand, setEditingCommand] = useState<MCPCommand | null>(null);
  const [isAddCommandFormOpen, setIsAddCommandFormOpen] = useState(false);
  const [activeView, setActiveView] = useState<ActiveView>('servers');
  const configEditorRef = useRef<ConfigEditorRef>(null);
  // New state for commands attempting graceful stop
  const [stoppingCommandIds, setStoppingCommandIds] = useState<Set<string>>(new Set());
  // New state for commands that failed automatic cleanup
  const [cleanupFailedCommandIds, setCleanupFailedCommandIds] = useState<Set<string>>(new Set());
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

  // --- Add helper to clear cleanup failed state ---
  const clearCleanupFailedState = (id: string) => {
    setCleanupFailedCommandIds(prev => {
      const newSet = new Set(prev);
      newSet.delete(id);
      return newSet;
    });
  };
  // --- End helper ---

  const loadConfig = async () => {
    try {
      setError(null);
      setCleanupFailedCommandIds(new Set()); // Clear failed state on reload
      // Reset terminal state on load
      setActiveTerminalIds([]);
      setCurrentTerminalTabId(null);
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

  // --- Callback to open/select a terminal tab ---
  const openTerminalTab = (id: string) => {
    setActiveTerminalIds(prevIds => {
      // Add ID if it's not already present
      if (!prevIds.includes(id)) {
        return [...prevIds, id];
      }
      return prevIds;
    });
    setCurrentTerminalTabId(id); // Always switch to the requested tab
  };
  // --- End openTerminalTab ---

  const handleToggleCommand = async (cmd: MCPCommand, forceRetry: boolean = false) => {
    const cmdId = cmd.id;
    console.log(`Toggling command ${cmdId}... Force Retry: ${forceRetry}`);
    setError(null); // Clear general error first
    clearCleanupFailedState(cmdId); // Clear specific cleanup error state for this command

    // Prevent toggle if already stopping gracefully (unless forcing retry)
    if (stoppingCommandIds.has(cmdId) && !forceRetry) {
      console.warn(`Command ${cmdId} is already in the process of stopping gracefully. Ignoring toggle.`);
      return;
    }

    try {
      const currentBackendInfo = commandInfo[cmdId];
      const isCurrentlyRunning = currentBackendInfo ? currentBackendInfo.is_running : cmd.isRunning;

      let backendResponseInfo: CommandInfo;
      let wasStartAttempt = false;

      if (!isCurrentlyRunning || forceRetry) { // Attempt start if not running OR if forcing retry
        console.log(`Attempting to start command ${cmdId} (Force: ${forceRetry})`);
        wasStartAttempt = true;
        try {
          // If forcing retry, call force kill first *without polling*
          if (forceRetry) {
            console.log(`Force Retry: Calling force_kill_command for ${cmdId} before starting.`);
            try {
              await invoke<CommandInfo>("force_kill_command", { id: cmdId });
            } catch (forceKillError) {
               console.warn(`Force kill before retry failed for ${cmdId}: ${forceKillError}. Proceeding with start attempt anyway.`);
            }
             // Optional short delay after force kill during force retry
             await new Promise(resolve => setTimeout(resolve, 250)); 
          }

          backendResponseInfo = await invoke<CommandInfo>("start_command", { id: cmdId });
          console.log(`Start command ${cmdId} backend response:`, backendResponseInfo);

        } catch (error: unknown) {
          const startError = error instanceof Error ? error.message : String(error);

          // Handle "already running" specifically for non-force retries
          if (startError.includes("already running according to backend state") && !forceRetry) {
            console.log(`Got "already running" error for ${cmdId}, attempting force cleanup and poll...`);
            try {
              // 1. Try force kill first
              await invoke<CommandInfo>("force_kill_command", { id: cmdId });
              console.log(`Force kill sent for ${cmdId}.`);

              // 2. Poll for backend confirmation that it stopped
              let attempts = 0;
              const maxAttempts = 10; // Poll for max 5 seconds (10 * 500ms)
              let isConfirmedStopped = false;
              while (attempts < maxAttempts) {
                attempts++;
                console.log(`Polling status attempt ${attempts} for ${cmdId}...`);
                try {
                  const currentInfo = await invoke<CommandInfo>("get_command_info", { id: cmdId });
                  if (!currentInfo.is_running) {
                    console.log(`Backend confirmed ${cmdId} is stopped.`);
                    isConfirmedStopped = true;
                    break; // Exit poll loop
                  }
                } catch (pollError) {
                  console.warn(`Polling ${cmdId} failed (${pollError}), assuming stopped.`);
                  isConfirmedStopped = true;
                  break;
                }
                await new Promise(resolve => setTimeout(resolve, 500));
              }

              if (!isConfirmedStopped) {
                // *** SET SPECIFIC CLEANUP FAILED STATE INSTEAD OF THROWING ***
                console.error(`Backend did not confirm ${cmdId} stopped after ${maxAttempts} attempts.`);
                setError(`Failed to start '${cmdId}'. The previous instance could not be stopped automatically.`); // Set general user-friendly error
                setCleanupFailedCommandIds(prev => new Set(prev).add(cmdId)); // Set specific command state
                return; // Stop execution for this command toggle
              }

              // 3. Retry start
              console.log(`Retrying start command for ${cmdId}...`);
              backendResponseInfo = await invoke<CommandInfo>("start_command", { id: cmdId });
              console.log(`Successfully restarted ${cmdId} after force cleanup and polling.`);

            } catch (cleanupOrRetryError) {
              // If cleanup/polling/retry itself fails, set general error
              const errorMsg = cleanupOrRetryError instanceof Error ? cleanupOrRetryError.message : String(cleanupOrRetryError);
              setError(`Failed during cleanup/retry for ${cmdId}: ${errorMsg}`);
               // Also set specific state if the final retry fails similarly
              if (errorMsg.includes("already running according to backend state")) {
                  setCleanupFailedCommandIds(prev => new Set(prev).add(cmdId));
              }
              return; // Stop execution
            }
          } else {
            // Re-throw or handle other start errors (including errors during forceRetry)
             setError(`Failed to start ${cmdId}: ${startError}`);
             if (startError.includes("already running according to backend state")) {
                 setCleanupFailedCommandIds(prev => new Set(prev).add(cmdId));
             }
             return; // Stop execution
          }
        }
      } else { // Handle Stop case (no changes needed here for now)
         // ... existing stop logic ...
         console.log(`Attempting graceful stop for command ${cmdId}`);
         setStoppingCommandIds(prev => new Set(prev).add(cmdId));
         
         backendResponseInfo = await invoke<CommandInfo>("stop_command", { id: cmdId });
         console.log(`Graceful stop command ${cmdId} backend response:`, backendResponseInfo);
 
         // ... rest of stop logic with timeout ...
      }

      // --- Update state based on backendResponseInfo (if successful) ---
      // Ensure we have a valid response before updating state
      if (backendResponseInfo) { 
          setCommandInfo(prev => ({ 
              ...prev, 
              [cmdId]: backendResponseInfo 
          }));
          // Only update the main command list's isRunning if it was a start attempt
          if (wasStartAttempt) {
            setCommands(prevCmds => prevCmds.map(c => 
                c.id === cmdId ? { ...c, isRunning: backendResponseInfo.is_running } : c
            ));
            // Clear failed state on successful start
            if (backendResponseInfo.is_running) {
               clearCleanupFailedState(cmdId);
            }
          }
    
          // --- Auto-open terminal tab logic ---
          if (wasStartAttempt && backendResponseInfo.is_running) {
            console.log(`Command ${cmdId} started, opening terminal tab.`);
            openTerminalTab(cmdId);
          }
      } // End if (backendResponseInfo)
      // --- End Update state ---

    } catch (err) { // General catch block for unexpected errors in toggle logic
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`General error in toggle command ${cmdId}:`, errorMsg);
      setError(errorMsg);
      // Ensure stopping state is cleared if an error occurred during stop attempt
      if (stoppingCommandIds.has(cmdId)) {
         console.warn(`Toggle failed for stopping ${cmdId}, clearing timer and stopping state.`);
         clearTimeout(stopTimersRef.current[cmdId]);
         delete stopTimersRef.current[cmdId];
         setStoppingCommandIds(prev => {
           const newSet = new Set(prev);
           newSet.delete(cmdId);
           return newSet;
         });
      }
       // Also ensure cleanup failed state is reset if a general error happens?
       // Or maybe not, depends if the general error could be related to the failed state.
       // Let's leave it for now, it gets cleared on next toggle attempt.
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
      // --- Close terminal tab if it was open for the removed command ---
      handleCloseTab(idToRemove, true); // Pass true to indicate removal
      // --- End close terminal tab ---
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

  // --- Terminal Tab Handlers ---
  const handleSelectTab = useCallback((id: string) => {
    setCurrentTerminalTabId(id);
  }, []);

  const handleCloseTab = useCallback((idToClose: string, isBeingRemoved: boolean = false) => {
    setActiveTerminalIds(prevIds => {
      const newIds = prevIds.filter(id => id !== idToClose);
      
      // If the closed tab was the current one, select another tab
      if (currentTerminalTabId === idToClose) {
        if (newIds.length > 0) {
          // Select the last tab in the new list
          setCurrentTerminalTabId(newIds[newIds.length - 1]); 
        } else {
          setCurrentTerminalTabId(null); // No tabs left
        }
      } // else: closing an inactive tab, currentTabId remains the same

      // If the command is NOT being removed entirely, 
      // ensure we clear stopping/cleanup states if the user manually closes the tab
      // during these states.
      if (!isBeingRemoved) {
         if (stoppingCommandIds.has(idToClose)) {
            console.warn(`Closed terminal tab for stopping command ${idToClose}, clearing stop state.`);
            clearTimeout(stopTimersRef.current[idToClose]);
            delete stopTimersRef.current[idToClose];
            setStoppingCommandIds(prev => {
              const newSet = new Set(prev);
              newSet.delete(idToClose);
              return newSet;
            });
         }
         if (cleanupFailedCommandIds.has(idToClose)) {
             console.warn(`Closed terminal tab for cleanup-failed command ${idToClose}, clearing failed state.`);
             clearCleanupFailedState(idToClose);
         }
      }
      
      return newIds;
    });
  }, [currentTerminalTabId, stoppingCommandIds, cleanupFailedCommandIds]); // Include dependencies
  // --- End Terminal Tab Handlers ---

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
          paddingBottom: activeTerminalIds.length > 0 ? `calc(${TERMINAL_APPROX_HEIGHT} + 2rem)` : '2rem',
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

        {/* --- Error Display (General) --- */}
        {error && (
          <div className="error-message general-error">
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
                  const isCleanupFailed = cleanupFailedCommandIds.has(cmd.id);
                  const isMenuDisabled = isRunning || isStopping; // Keep menu disabled if running/stopping
                  
                  return (
                    <div key={cmd.id} className={`command-item ${hasError && !isRunning && !isCleanupFailed ? 'error-state' : ''} ${isStopping ? 'stopping-state' : ''} ${isCleanupFailed ? 'cleanup-failed-state' : ''}`}>
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
                        {/* --- Specific Action Button Area --- */}
                        {isCleanupFailed ? (
                          // --- Cleanup Failed State --- 
                          <div className="cleanup-failed-actions">
                            <button 
                              className="action-button retry-button" // Style as needed
                              onClick={() => handleToggleCommand(cmd, true)} // Pass forceRetry = true
                            >
                              {/* Consider adding a specific icon VscSync ? */}
                              Force Stop & Retry Start
                            </button>
                             <p className="cleanup-failed-guidance">
                               If retry fails, check Activity Monitor/Task Manager for '{cmd.name}' or restart MCP Runner.
                             </p>
                          </div>
                        ) : (
                          // --- Normal State --- 
                          <>
                            <button 
                              className={`action-button ${isRunning ? (isStopping ? 'stopping' : 'stop') : 'start'}`}
                              onClick={() => handleToggleCommand(cmd)} // Normal toggle
                              disabled={isStopping} // Disable toggle button while stopping
                            >
                              {/* Restore button content based on state */}
                              {isStopping ? (
                                <>
                                  {/* Optional: Add a spinner icon here later? */}
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
                                onClick={() => openTerminalTab(cmd.id)} // Use openTerminalTab
                                disabled={false} // Still never disable
                              >
                                <VscTerminal className="button-icon" />
                                Terminal
                              </button>
                            )}
                          </>
                        )}
                        {/* --- End Specific Action Button Area --- */}
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

      {/* --- Render Tabbed Terminal Container --- */}
      <TabbedTerminalContainer
        activeIds={activeTerminalIds}
        currentTabId={currentTerminalTabId}
        onSelectTab={handleSelectTab}
        onCloseTab={handleCloseTab}
      />
      {/* --- End Render Tabbed Terminal --- */}

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
