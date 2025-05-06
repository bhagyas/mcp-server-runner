import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from '@tauri-apps/api/core';
import { confirm } from '@tauri-apps/plugin-dialog';
import type { MCPCommand, AddMCPCommand, Config, MCPServerConfig } from "./types/mcp";
import { AddMCPCommand as AddMCPCommandForm } from "./components/AddMCPCommand";
import { TabbedTerminalContainer } from "./components/TabbedTerminalContainer";
import { ConfigEditor, ConfigEditorRef } from "./components/ConfigEditor";
import { Settings } from "./components/Settings";
import { VscServer, VscSettingsGear, VscAdd, VscJson, VscTerminal, VscTrash, VscEdit, VscDebugStart, VscDebugStop, VscSave, VscStopCircle } from "react-icons/vsc";
import "./App.css";

// Define the richer CommandStatus enum (mirroring hypothetical backend)
// This still assumes the backend sends this structure via get_command_info
type CommandStatus =
  | { state: 'Idle' }
  | { state: 'Starting' }
  | { state: 'Running' }
  | { state: 'Stopping' }
  | { state: 'Killing' }
  | { state: 'Finished'; code: number | null; success: boolean }
  | { state: 'Error'; message: string };

// Update CommandInfo interface (used for the polled state)
interface CommandInfo {
  id: string;
  status: CommandStatus;
  process_id?: number;
  port?: number;
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
  const forceKillPromptTimerRef = useRef<Record<string, number>>({});

  useEffect(() => {
    loadConfig();

    // --- Cleanup Timers on Unmount ---
    return () => {
      console.log("App unmounting, clearing stop timers.");
      Object.values(forceKillPromptTimerRef.current).forEach(clearTimeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps 
  }, []); // Run only on mount

  // Effect for polling command statuses
  useEffect(() => {
    const intervalId = setInterval(async () => {
      // Poll all commands that are potentially active or were recently active
      // A simple approach is to poll all commands present in the `commandInfo` state keys
      // Or poll all commands defined in `commands` array
      const idsToPoll = commands.map(cmd => cmd.id);
      // More sophisticated: Poll only those not in Idle/Finished/Error state?
      // Let's keep it simple and poll all configured commands for now.

      if (idsToPoll.length === 0) return;

      // console.log(`Polling status for commands: ${idsToPoll.join(', ')}`);
      const updates: Record<string, CommandInfo> = {};
      let stateChanged = false;

      for (const id of idsToPoll) {
        try {
          // Assume backend should return the full CommandInfo with the status enum
          const latestInfo = await invoke<CommandInfo>("get_command_info", { id });
          
          // *** Add Check for valid data structure ***
          if (!latestInfo || typeof latestInfo !== 'object' || !latestInfo.status || typeof latestInfo.status !== 'object') {
            console.error(`Polling for ${id} received invalid data structure:`, latestInfo);
            // Set an Error status or handle appropriately
            const currentStatusState = commandInfo[id]?.status?.state;
            // Only update if not already marked as error from invalid data
            if(currentStatusState !== 'Error' || (commandInfo[id]?.status as any)?.message !== 'Invalid data received from backend poll') {
                updates[id] = { id, status: { state: 'Error', message: 'Invalid data received from backend poll' } };
                stateChanged = true;
            }
            // Clear any prompt timer if data is invalid
            if (forceKillPromptTimerRef.current[id]) {
                 clearTimeout(forceKillPromptTimerRef.current[id]);
                 delete forceKillPromptTimerRef.current[id];
             }
            continue; // Skip processing this invalid entry
          }
          // *** End Check ***

          // Now safe to access latestInfo.status
          const currentStatusState = commandInfo[id]?.status?.state;
          const latestStatusState = latestInfo.status.state;
          
          if (JSON.stringify(commandInfo[id]?.status) !== JSON.stringify(latestInfo.status)) {
             console.log(`Command ${id} status changed: ${currentStatusState ?? 'Unknown'} -> ${latestStatusState}`);
             updates[id] = latestInfo;
             stateChanged = true;

             // --- Handle Force Kill Prompt Timeout --- 
             const forceKillTimerId = forceKillPromptTimerRef.current[id];
             if (latestStatusState !== 'Stopping' && forceKillTimerId) {
                 console.log(`Command ${id} is no longer Stopping. Clearing force kill prompt timer.`);
                 clearTimeout(forceKillTimerId);
                 delete forceKillPromptTimerRef.current[id];
             }
             // --- End Force Kill Timeout Handling ---
          }

        } catch (err) {
          // Handle cases where the command might have been removed or backend error
          const errorMsg = err instanceof Error ? err.message : String(err);
          // If polling fails for a command we *thought* was active, mark as error or remove?
          // Let's mark it as error for now.
          if (commandInfo[id] && commandInfo[id]?.status.state !== 'Idle' && commandInfo[id]?.status.state !== 'Finished') {
              console.error(`Polling failed for potentially active command ${id}:`, err);
              updates[id] = { id, status: { state: 'Error', message: `Polling failed: ${errorMsg}` } };
              stateChanged = true;
               // Clear any prompt timer if polling fails
              if (forceKillPromptTimerRef.current[id]) {
                  clearTimeout(forceKillPromptTimerRef.current[id]);
                  delete forceKillPromptTimerRef.current[id];
              }
          } else {
            // If polling fails for an idle/finished command, maybe ignore or log differently
            // console.warn(`Polling failed for idle/finished command ${id}: ${errorMsg}`);
            // Or maybe remove it from commandInfo if not in commands list?
             if (!commands.some(c => c.id === id) && commandInfo[id]) {
                console.log(`Removing stale command info for ${id} after poll failure.`);
                // Need a way to signal removal rather than update
                // For now, just update to Error state.
                 updates[id] = { id, status: { state: 'Error', message: `Polling failed: ${errorMsg}` } };
                 stateChanged = true;
             }
          }
        }
      }

      // Update state only if any command status changed
      if (stateChanged) {
        setCommandInfo(prevInfo => ({ 
          ...prevInfo,
          ...updates,
        }));
      }

    }, 2000); // Poll every 2 seconds

    // Cleanup interval on component unmount
    return () => {
       clearInterval(intervalId);
       // Clear any remaining prompt timers on unmount
       Object.values(forceKillPromptTimerRef.current).forEach(clearTimeout);
    };

  }, [commands, commandInfo]); // Depend on commands and commandInfo

  // Helper to check if a command is in a state that prevents user actions
  const isActionLocked = (status: CommandStatus | undefined): boolean => {
      if (!status) return false; // If no info, assume not locked
      return status.state === 'Starting' || status.state === 'Stopping' || status.state === 'Killing';
  };

  const loadConfig = async () => {
    try {
      setError(null);
      const config = await invoke<Config>("load_config", { configPath: null });
      const initialInfo: Record<string, CommandInfo> = {};
      const loadedCommands: MCPCommand[] = Object.entries(config.mcpServers).map(([id, server]) => {
        initialInfo[id] = { id, status: { state: 'Idle' } };
        return {
          id,
          name: id,
          command: (server as MCPServerConfig).command,
          args: (server as MCPServerConfig).args,
          env: (server as MCPServerConfig).env,
          port: (server as MCPServerConfig).port,
          isRunning: false, // Initialize according to imported type
        };
      });
      setCommands(loadedCommands);
      setCommandInfo(initialInfo);
      Object.values(forceKillPromptTimerRef.current).forEach(clearTimeout);
      forceKillPromptTimerRef.current = {};
    } catch (err) {
       const errorMsg = err instanceof Error ? err.message : String(err);
       console.error("Load config failed:", errorMsg);
       setError(errorMsg);
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

  const handleEditCommand = async (editedData: AddMCPCommand & { originalId: string }) => {
    console.log("Editing command:", editedData.originalId);
    const currentInfo = commandInfo[editedData.originalId];
    const currentStatus = currentInfo?.status?.state ?? 'Idle';

    if (currentStatus !== 'Idle' && currentStatus !== 'Finished' && currentStatus !== 'Error') {
         setError(`Cannot edit server '${editedData.originalId}' while it is ${currentStatus}. Stop it first.`);
         return;
    }

    try {
      setError(null);
      // Remove original using the originalId
      await invoke<Config>("remove_server", { name: editedData.originalId }); 
      // Add new server using data from the form (editedData)
      await invoke<Config>("add_server", { 
          name: editedData.name, 
          command: editedData.command,
          args: editedData.args,
          env: editedData.env,
          port: editedData.port,
          // No need to pass isRunning here
       });
      await loadConfig(); // Reload to get fresh state
      setIsAddCommandFormOpen(false);
      setEditingCommand(null); // Clear editing state
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

  const handleToggleCommand = async (cmd: MCPCommand) => {
    const cmdId = cmd.id;
    const currentInfo = commandInfo[cmdId];
    const currentStatus = currentInfo?.status ?? { state: 'Idle' };

    console.log(`Toggling command ${cmdId}. Polled status: ${currentStatus.state}`);
    setError(null);

    try {
      let targetCommand: string | null = null;

      switch (currentStatus.state) {
        case 'Idle':
        case 'Finished':
        case 'Error':
          targetCommand = "start_command";
          break;
        case 'Running':
          targetCommand = "stop_command";
          break;
        case 'Starting':
        case 'Stopping': // Maybe allow force kill from here?
        case 'Killing':
          console.warn(`Command ${cmdId} is already ${currentStatus.state}. Ignoring toggle.`);
          return; // Do nothing if in a transition state
      }

      if (targetCommand) {
         console.log(`Invoking ${targetCommand} for ${cmdId}`);
         const backendResponseInfo = await invoke<CommandInfo>(targetCommand, { id: cmdId });
         console.log(`Backend response for ${targetCommand} on ${cmdId}:`, backendResponseInfo);

         // *** Add Validation for backendResponseInfo structure ***
         if (!backendResponseInfo || typeof backendResponseInfo !== 'object' || !backendResponseInfo.status || typeof backendResponseInfo.status !== 'object') {
            console.error(`Invoke ${targetCommand} for ${cmdId} received invalid data structure:`, backendResponseInfo);
            // Set Error status
            setCommandInfo(prev => ({ 
                ...prev, 
                [cmdId]: { ...(prev[cmdId] ?? { id: cmdId }), status: { state: 'Error', message: `Invalid response from ${targetCommand}` } } 
            }));
             // Clear any prompt timer if data is invalid
            if (forceKillPromptTimerRef.current[cmdId]) {
                 clearTimeout(forceKillPromptTimerRef.current[cmdId]);
                 delete forceKillPromptTimerRef.current[cmdId];
            }
            return; // Stop further processing for this invalid response
         }
         // *** End Validation ***

         // Now safe to process backendResponseInfo
         setCommandInfo(prev => ({ ...prev, [cmdId]: backendResponseInfo }));

         if (targetCommand === 'start_command' && backendResponseInfo.status.state === 'Running') {
             openTerminalTab(cmdId);
         }

         if (targetCommand === 'stop_command') {
             // Clear any existing timer first
             if (forceKillPromptTimerRef.current[cmdId]) {
                 clearTimeout(forceKillPromptTimerRef.current[cmdId]);
             }
             console.log(`Starting force kill prompt timer for ${cmdId}`);
             forceKillPromptTimerRef.current[cmdId] = setTimeout(async () => {
                // Check FRESH status when timer fires
                try {
                    const freshInfo = await invoke<CommandInfo>("get_command_info", { id: cmdId });
                    if (freshInfo.status.state === 'Stopping') { // Still stopping?
                        console.log(`Command ${cmdId} still Stopping after timeout. Prompting user.`);
                        const userConfirmedForceKill = await confirm(
                           `Process "${cmdId}" is still stopping after ${GRACEFUL_STOP_TIMEOUT / 1000} seconds. Force kill?`,
                           { title: 'Force Kill Process?', okLabel: 'Force Kill', cancelLabel: 'Cancel' }
                        );
                        if (userConfirmedForceKill) {
                           handleForceKill(cmdId); // Call dedicated force kill handler
                        }
                    } else {
                        console.log(`Command ${cmdId} is no longer Stopping. No prompt needed.`);
                    }
                } catch(err) {
                    console.error(`Error checking status for ${cmdId} during prompt timer: ${err}`);
                }
                // Timer finished, remove ref
                 delete forceKillPromptTimerRef.current[cmdId];

             }, GRACEFUL_STOP_TIMEOUT);
         }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`Error toggling command ${cmdId}:`, errorMsg);
      setError(`Toggle failed for ${cmdId}: ${errorMsg}`);
      // Update local state to Error on failure?
       setCommandInfo(prev => ({ 
           ...prev, 
           [cmdId]: { ...(prev[cmdId] ?? { id: cmdId }), status: { state: 'Error', message: errorMsg } } 
       }));
    }
  };

  // --- Dedicated Force Kill Handler --- 
  const handleForceKill = async (cmdId: string) => {
    console.log(`Handling force kill for ${cmdId}`);
    setError(null);
     // Clear any pending prompt timer immediately
    if (forceKillPromptTimerRef.current[cmdId]) {
        clearTimeout(forceKillPromptTimerRef.current[cmdId]);
        delete forceKillPromptTimerRef.current[cmdId];
    }

    try {
      // Check current status before sending kill
      const currentStatus = commandInfo[cmdId]?.status?.state;
       if (currentStatus !== 'Running' && currentStatus !== 'Stopping') {
          console.warn(`Cannot force kill ${cmdId}, status is ${currentStatus}.`);
          // Maybe show error? setError(`Cannot force kill ${cmdId}, status is ${currentStatus}.`);
          return;
       }

      console.log(`Invoking force_kill_command for ${cmdId}`);
      const backendResponseInfo = await invoke<CommandInfo>("force_kill_command", { id: cmdId });
      console.log(`Backend response for force_kill on ${cmdId}:`, backendResponseInfo);

      // *** Add Validation for backendResponseInfo structure ***
      if (!backendResponseInfo || typeof backendResponseInfo !== 'object' || !backendResponseInfo.status || typeof backendResponseInfo.status !== 'object') {
        console.error(`Invoke force_kill_command for ${cmdId} received invalid data structure:`, backendResponseInfo);
        setCommandInfo(prev => ({ 
            ...prev, 
            [cmdId]: { ...(prev[cmdId] ?? { id: cmdId }), status: { state: 'Error', message: 'Invalid response from force_kill' } } 
        }));
        return; 
      }
      // *** End Validation ***

      // Update state immediately
      setCommandInfo(prev => ({ ...prev, [cmdId]: backendResponseInfo }));
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`Error force killing command ${cmdId}:`, errorMsg);
      setError(`Force kill failed for ${cmdId}: ${errorMsg}`);
       setCommandInfo(prev => ({ 
           ...prev, 
           [cmdId]: { ...(prev[cmdId] ?? { id: cmdId }), status: { state: 'Error', message: `Force kill failed: ${errorMsg}` } } 
       }));
    }
  };

  const handleRemoveCommand = async (idToRemove: string) => {
    const currentInfo = commandInfo[idToRemove];
    const currentStatus = currentInfo?.status?.state ?? 'Idle';
    
    if (currentStatus !== 'Idle' && currentStatus !== 'Finished' && currentStatus !== 'Error') {
         setError(`Cannot remove server '${idToRemove}' while it is ${currentStatus}. Stop it first.`);
         setOpenMenuId(null);
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
      // --- State updates after successful removal --- 
      // 1. Remove from commands list
      setCommands(prev => prev.filter(cmd => cmd.id !== idToRemove));
      // 2. Remove from commandInfo state
      setCommandInfo(prev => {
          const newState = { ...prev };
          delete newState[idToRemove];
          return newState;
      });
      // 3. Close terminal tab
      handleCloseTab(idToRemove, true); 
      // 4. Clear any prompt timer
       if (forceKillPromptTimerRef.current[idToRemove]) {
           clearTimeout(forceKillPromptTimerRef.current[idToRemove]);
           delete forceKillPromptTimerRef.current[idToRemove];
       }
      // --- End state updates ---
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

  const handleFormSubmit = (formData: AddMCPCommand) => {
    if (editingCommand) {
      handleEditCommand({ 
        ...formData,
        originalId: editingCommand.id,
       });
    } else {
      handleAddCommand(formData);
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

  // isBeingRemoved flag is less critical now, backend state dictates actions.
  // Closing a tab doesn't need to force-clear backend-driven states.
  const handleCloseTab = useCallback((idToClose: string, isBeingRemoved: boolean = false) => {
    setActiveTerminalIds(prevIds => {
      const newIds = prevIds.filter(id => id !== idToClose);
      if (currentTerminalTabId === idToClose) {
        setCurrentTerminalTabId(newIds.length > 0 ? newIds[newIds.length - 1] : null);
      }
      // Clear prompt timer if tab is closed manually
      if (!isBeingRemoved && forceKillPromptTimerRef.current[idToClose]){
          console.warn(`Closed terminal tab for ${idToClose} during stop timeout, clearing prompt timer.`);
          clearTimeout(forceKillPromptTimerRef.current[idToClose]);
          delete forceKillPromptTimerRef.current[idToClose];
      }
      return newIds;
    });
  }, [currentTerminalTabId]); // Removed stopping/cleanup states from deps
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
                     {Object.values(commandInfo).filter(info => info.status.state === 'Running').length}
                  </div>
                </div>
              </div>

              {/* Command list specific to Servers view */}
              <div className="commands-list">
                {commands.map((cmd: MCPCommand) => {
                  const currentInfo = commandInfo[cmd.id];
                  const status = currentInfo?.status ?? { state: 'Idle' };
                  const hasError = status.state === 'Error' || (status.state === 'Finished' && !status.success);
                  const isLocked = isActionLocked(status);

                  let buttonContent: React.ReactNode = null;
                  let buttonAction = () => handleToggleCommand(cmd);
                  let buttonClassName = "action-button";
                  let isButtonDisabled = false;
                  let showForceKillButton = false;

                  if (!currentInfo) {
                      // Before first poll: Use cmd.isRunning as a basic hint
                      if (cmd.isRunning) {
                          buttonContent = <><VscDebugStop className="button-icon" /> Stop</>;
                          buttonClassName += " stop";
                      } else {
                          buttonContent = <><VscDebugStart className="button-icon" /> Start</>;
                          buttonClassName += " start";
                      }
                      // Button is enabled before first poll
                  } else {
                      // After first poll: Use detailed status
                      switch (status.state) {
                         case 'Idle':
                         case 'Finished':
                         case 'Error':
                           buttonContent = <><VscDebugStart className="button-icon" /> Start</>;
                           buttonClassName += " start";
                           break;
                         case 'Running':
                           buttonContent = <><VscDebugStop className="button-icon" /> Stop</>;
                           buttonClassName += " stop";
                           break;
                         case 'Starting':
                           buttonContent = <>Starting...</>; 
                           isButtonDisabled = true;
                           break;
                         case 'Stopping':
                           buttonContent = <>Stopping...</>; 
                           isButtonDisabled = true;
                           showForceKillButton = true;
                           break;
                         case 'Killing':
                           buttonContent = <>Killing...</>; 
                           isButtonDisabled = true;
                           break;
                      }
                  }
                  
                  return (
                    <div key={cmd.id} className={`command-item ${hasError ? 'error-state' : ''} ${isLocked ? 'locked-state' : ''}`}>
                       <div className="command-header">
                         <div className="command-name">
                           <span className={`status-indicator state-${status.state.toLowerCase()} ${hasError ? 'error' : ''}`} />
                           {cmd.name}
                         </div>
                         <div className="menu-container">
                           <button 
                            className="menu-button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setOpenMenuId(openMenuId === cmd.id ? null : cmd.id);
                            }}
                            disabled={isLocked}
                           >
                             <div className="menu-dots">⋮</div>
                           </button>
                           {openMenuId === cmd.id && (
                            <div className="dropdown-menu">
                              <button onClick={() => {
                                setEditingCommand(cmd);
                                setIsAddCommandFormOpen(true);
                                setOpenMenuId(null);
                              }} disabled={isLocked}> <VscEdit/> Edit </button>
                              <button onClick={() => handleRemoveCommand(cmd.id)} disabled={isLocked} className="delete"> <VscTrash/> Remove </button>
                            </div>
                           )}
                         </div>
                       </div>
                       {status.state === 'Error' && (
                           <div className="error-message command-error">Error: {status.message}</div>
                       )}
                       {status.state === 'Finished' && (
                           <div className="info-row exit-code">
                              <span className="info-label">Exit Code</span>
                              <span className={`info-value ${status.success ? 'success' : 'error'}`}>{status.code ?? 'N/A'} ({status.success ? 'Success' : 'Failed'})</span>
                           </div>
                       )}
                       <div className="command-info">
                         <div className="info-row">
                            <span className="info-label">Command</span>
                            <span className="info-value">{cmd.command} {cmd.args.join(' ')}</span>
                          </div>
                          {cmd.port && (
                            <div className="info-row">
                              <span className="info-label">Configured Port</span>
                              <span className="info-value">{cmd.port}</span>
                            </div>
                          )}
                          {currentInfo?.process_id && status.state === 'Running' && (
                            <div className="info-row">
                              <span className="info-label">Process ID</span>
                              <span className="info-value">{currentInfo.process_id}</span>
                            </div>
                          )}
                          {currentInfo?.port && status.state === 'Running' && (
                            <div className="info-row">
                              <span className="info-label">Active Port</span>
                              <span className="info-value">{currentInfo.port}</span>
                            </div>
                          )}
                          {Object.entries(cmd.env || {}).length > 0 && (
                            <div className="info-row">
                              <span className="info-label">Env</span>
                              <span className="info-value">{Object.entries(cmd.env || {}).map(([k, v]) => `${k}=${v}`).join(', ')}</span>
                            </div>
                          )}
                       </div>
                       <div className="command-actions">
                          {buttonContent && (
                             <button 
                               className={buttonClassName}
                               onClick={buttonAction}
                               disabled={isButtonDisabled}
                             >
                               {buttonContent}
                             </button>
                          )}
                          {showForceKillButton && (
                             <button 
                                className="action-button stop force-kill"
                                onClick={() => handleForceKill(cmd.id)}
                                title="Force Kill Process"
                              >
                                 <VscStopCircle className="button-icon" /> 
                                 Force Kill
                              </button>
                          )}
                          {(status.state === 'Running' || status.state === 'Starting' || status.state === 'Stopping' || status.state === 'Killing') && ( 
                            <button 
                              className="action-button secondary"
                              onClick={() => openTerminalTab(cmd.id)}
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
