import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { MCPCommand, AddMCPCommand, Config } from "./types/mcp";
import { AddMCPCommand as AddMCPCommandForm } from "./components/AddMCPCommand";
import { Terminal } from "./components/Terminal";
import { ConfigEditor } from "./components/ConfigEditor";
import "./App.css";

interface CommandInfo {
  id: string;
  is_running: boolean;
  port: number | null;
  has_error: boolean;
}

function App() {
  const [commands, setCommands] = useState<MCPCommand[]>([]);
  const [commandInfo, setCommandInfo] = useState<Record<string, CommandInfo>>({});
  const [error, setError] = useState<string | null>(null);
  const [selectedCommand, setSelectedCommand] = useState<string | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [editingCommand, setEditingCommand] = useState<MCPCommand | null>(null);
  const [isConfigEditorOpen, setIsConfigEditorOpen] = useState(false);

  useEffect(() => {
    loadConfig();
  }, []);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (openMenuId && !(event.target as Element).closest('.menu-container')) {
        setOpenMenuId(null);
      }
    };

    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [openMenuId]);

  // Poll for command info updates
  useEffect(() => {
    if (commands.length === 0) return;

    const interval = setInterval(async () => {
      for (const cmd of commands) {
        if (cmd.isRunning) {
          try {
            const info = await invoke<CommandInfo>("get_command_info", { id: cmd.id });
            setCommandInfo(prev => ({
              ...prev,
              [cmd.id]: info
            }));
          } catch (err) {
            console.error('Failed to get command info:', err);
          }
        }
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [commands]);

  const loadConfig = async () => {
    try {
      setError(null);
      const config = await invoke<Config>("load_config", { configPath: null });
      setCommands(Object.entries(config.mcp_servers).map(([id, server]) => ({
        id,
        name: id,
        command: server.command,
        args: server.args,
        isRunning: false,
      })));
    } catch (err) {
      setError(err as string);
    }
  };

  const handleAddCommand = async (newCommand: AddMCPCommand) => {
    try {
      setError(null);
      await invoke<Config>("add_server", {
        name: newCommand.name,
        command: newCommand.command,
        args: newCommand.args,
      });
      
      await loadConfig();
    } catch (err) {
      setError(err as string);
    }
  };

  const handleToggleCommand = async (cmd: MCPCommand) => {
    try {
      setError(null);
      if (!cmd.isRunning) {
        const result = await invoke<CommandInfo>("start_command", {
          id: cmd.id,
        });
        
        setCommands((prev) =>
          prev.map((c) =>
            c.id === result.id ? { ...c, isRunning: result.is_running } : c
          )
        );
        setCommandInfo(prev => ({
          ...prev,
          [cmd.id]: result
        }));
      } else {
        const result = await invoke<CommandInfo>("stop_command", {
          id: cmd.id,
        });
        
        setCommands((prev) =>
          prev.map((c) =>
            c.id === result.id ? { ...c, isRunning: result.is_running } : c
          )
        );
        setCommandInfo(prev => ({
          ...prev,
          [cmd.id]: result
        }));
      }
    } catch (err) {
      setError(err as string);
    }
  };

  const handleRemoveCommand = async (name: string) => {
    try {
      setError(null);
      await invoke<Config>("remove_server", { name });
      await loadConfig();
      setOpenMenuId(null);
    } catch (err) {
      setError(err as string);
    }
  };

  const handleEditCommand = async (command: MCPCommand) => {
    try {
      setError(null);
      // If name changed, we need to remove the old command first
      if (command.name !== command.id) {
        await invoke<Config>("remove_server", { name: command.id });
      }
      
      // Add the command with new name and settings
      await invoke<Config>("add_server", {
        name: command.name,
        command: command.command,
        args: command.args,
      });
      
      await loadConfig();
      setEditingCommand(null);
    } catch (err) {
      setError(err as string);
    }
  };

  const handleSaveConfig = async (config: Config) => {
    try {
      setError(null);
      // Save the new configuration
      await invoke<void>("save_config", { config });
      
      // Update the commands list with the new configuration
      const runningStates = new Map(commands.map(cmd => [cmd.id, cmd.isRunning]));
      
      const newCommands = Object.entries(config.mcp_servers).map(([id, server]) => ({
        id,
        name: id,
        command: server.command,
        args: server.args,
        isRunning: runningStates.get(id) || false,
      }));
      
      setCommands(newCommands);
      setIsConfigEditorOpen(false); // Close the editor after successful save
    } catch (err) {
      setError(err as string);
      throw err;
    }
  };

  return (
    <main className="container">
      <h1>MCP Runner</h1>
      <AddMCPCommandForm 
        onAdd={handleAddCommand} 
        editCommand={editingCommand}
        onEdit={handleEditCommand}
        onCancelEdit={() => setEditingCommand(null)}
      />
      
      {error && (
        <div className="error-message">
          {error}
        </div>
      )}
      
      <div className="commands-list">
        {commands.map((cmd) => (
          <div key={cmd.id} className="command-item">
            <div className="command-header">
              <h3>
                {cmd.name}
                {cmd.isRunning && (
                  <span className={`status-indicator ${commandInfo[cmd.id]?.has_error ? 'error' : ''}`} />
                )}
              </h3>
              <div className="menu-container">
                <button 
                  className="menu-button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpenMenuId(openMenuId === cmd.id ? null : cmd.id);
                  }}
                >
                  <div className="menu-dots">
                    <span></span>
                    <span></span>
                    <span></span>
                  </div>
                </button>
                {openMenuId === cmd.id && (
                  <div className="dropdown-menu">
                    <button 
                      onClick={() => {
                        setEditingCommand(cmd);
                        setOpenMenuId(null);
                      }}
                      disabled={cmd.isRunning}
                    >
                      Edit
                    </button>
                    <button 
                      className="delete"
                      onClick={() => handleRemoveCommand(cmd.id)}
                      disabled={cmd.isRunning}
                    >
                      Remove
                    </button>
                  </div>
                )}
              </div>
            </div>
            <p>{cmd.command} {cmd.args.join(' ')}</p>
            <div className="command-info">
              {cmd.isRunning && (
                <span className="port-info">
                  {commandInfo[cmd.id]?.port 
                    ? `Running on port: ${commandInfo[cmd.id].port}`
                    : 'Detecting port...'}
                </span>
              )}
            </div>
            <div className="command-actions">
              <button onClick={() => handleToggleCommand(cmd)}>
                {cmd.isRunning ? 'Stop' : 'Start'}
              </button>
              {cmd.isRunning && (
                <button onClick={() => setSelectedCommand(cmd.id)}>
                  Terminal
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      <Terminal
        commandId={selectedCommand || ''}
        isVisible={selectedCommand !== null}
        onClose={() => setSelectedCommand(null)}
      />

      <ConfigEditor
        isVisible={isConfigEditorOpen}
        onClose={() => setIsConfigEditorOpen(false)}
        onSave={handleSaveConfig}
      />

      <button 
        className="edit-config-button"
        onClick={() => setIsConfigEditorOpen(true)}
        title="Edit Configuration"
      >
        ⚙️
      </button>
    </main>
  );
}

export default App;
