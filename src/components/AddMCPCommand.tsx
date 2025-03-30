import { useState, useEffect } from 'react';
import type { AddMCPCommand as AddMCPCommandType, MCPCommand } from '../types/mcp';

interface AddMCPCommandProps {
  isVisible: boolean;
  onClose: () => void;
  onSubmit: (command: AddMCPCommandType) => void;
  editCommand?: MCPCommand | null;
}

export function AddMCPCommand({ isVisible, onClose, onSubmit, editCommand }: AddMCPCommandProps) {
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [port, setPort] = useState<string>('');
  const [envVars, setEnvVars] = useState<Record<string, string>>({});
  const [newEnvKey, setNewEnvKey] = useState('');
  const [newEnvValue, setNewEnvValue] = useState('');

  useEffect(() => {
    if (editCommand) {
      setName(editCommand.name);
      setCommand(editCommand.command);
      setArgs(editCommand.args.join(' '));
      setPort(editCommand.port?.toString() || '');
      setEnvVars(editCommand.env || {});
    } else {
      setName('');
      setCommand('');
      setArgs('');
      setPort('');
      setEnvVars({});
      setNewEnvKey('');
      setNewEnvValue('');
    }
  }, [editCommand]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    const commandData = {
      name,
      command,
      args: args.split(' ').filter(arg => arg.length > 0),
      env: envVars,
      port: port ? parseInt(port, 10) : undefined
    };

    onSubmit(commandData);
    onClose();

    // Clear form
    setName('');
    setCommand('');
    setArgs('');
    setPort('');
    setEnvVars({});
    setNewEnvKey('');
    setNewEnvValue('');
  };

  const handleAddEnvVar = (e: React.FormEvent) => {
    e.preventDefault();
    if (newEnvKey && newEnvValue) {
      setEnvVars(prev => ({
        ...prev,
        [newEnvKey]: newEnvValue
      }));
      setNewEnvKey('');
      setNewEnvValue('');
    }
  };

  const handleRemoveEnvVar = (key: string) => {
    setEnvVars(prev => {
      const newVars = { ...prev };
      delete newVars[key];
      return newVars;
    });
  };

  if (!isVisible) return null;

  return (
    <div className="side-panel-overlay">
      <div className={`side-panel ${isVisible ? 'visible' : ''}`}>
        <div className="modal-header">
          <h2>{editCommand ? 'Edit Command' : 'Add New Command'}</h2>
          <button className="close-button" onClick={onClose}>×</button>
        </div>
        <form onSubmit={handleSubmit} className="add-command-form">
          <div className="form-group">
            <label htmlFor="name">Name:</label>
            <input
              id="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
          
          <div className="form-group">
            <label htmlFor="command">Command:</label>
            <input
              id="command"
              type="text"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              required
            />
          </div>
          
          <div className="form-group">
            <label htmlFor="args">Arguments (space separated):</label>
            <input
              id="args"
              type="text"
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              placeholder="e.g. --port 3000 --host localhost"
            />
          </div>

          <div className="form-group">
            <label htmlFor="port">Port (optional):</label>
            <input
              id="port"
              type="number"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              placeholder="e.g. 3000"
              min="1"
              max="65535"
            />
            <p className="field-description">
              For reference only. Does not modify the executed command.
            </p>
          </div>

          <div className="form-group env-vars">
            <label>Environment Variables:</label>
            <div className="env-vars-list">
              {Object.entries(envVars).map(([key, value]) => (
                <div key={key} className="env-var-item">
                  <span>{key}={value}</span>
                  <button 
                    type="button" 
                    onClick={() => handleRemoveEnvVar(key)}
                    className="remove-env-var"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <div className="add-env-var">
              <input
                type="text"
                value={newEnvKey}
                onChange={(e) => setNewEnvKey(e.target.value)}
                placeholder="KEY"
              />
              <input
                type="text"
                value={newEnvValue}
                onChange={(e) => setNewEnvValue(e.target.value)}
                placeholder="VALUE"
              />
              <button 
                type="button" 
                onClick={handleAddEnvVar}
                disabled={!newEnvKey || !newEnvValue}
                className="primary-button env-add-button"
              >
                Add
              </button>
            </div>
          </div>
          
          <div className="form-actions">
            <button type="submit" className="primary-button">
              {editCommand ? 'Save Changes' : 'Add Command'}
            </button>
            <button type="button" className="secondary-button" onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
} 