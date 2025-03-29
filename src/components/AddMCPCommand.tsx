import { useState, useEffect } from 'react';
import type { AddMCPCommand as AddMCPCommandType, MCPCommand } from '../types/mcp';

interface AddMCPCommandProps {
  onAdd: (command: AddMCPCommandType) => void;
  editCommand: MCPCommand | null;
  onEdit: (command: MCPCommand) => void;
  onCancelEdit: () => void;
}

export function AddMCPCommand({ onAdd, editCommand, onEdit, onCancelEdit }: AddMCPCommandProps) {
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');

  useEffect(() => {
    if (editCommand) {
      setName(editCommand.name);
      setCommand(editCommand.command);
      setArgs(editCommand.args.join(' '));
    }
  }, [editCommand]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    const commandData = {
      name,
      command,
      args: args.split(' ').filter(arg => arg.length > 0)
    };

    if (editCommand) {
      onEdit({
        ...commandData,
        id: editCommand.id,
        isRunning: editCommand.isRunning
      });
    } else {
      onAdd(commandData);
    }

    // Clear form
    setName('');
    setCommand('');
    setArgs('');
  };

  return (
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
      
      <div className="form-actions">
        <button type="submit">
          {editCommand ? 'Save Changes' : 'Add Command'}
        </button>
        {editCommand && (
          <button type="button" onClick={onCancelEdit}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
} 