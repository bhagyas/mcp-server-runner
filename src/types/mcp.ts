export interface MCPServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
  port?: number;
}

export interface Config {
  mcpServers: Record<string, MCPServerConfig>;
}

export interface MCPCommand {
  id: string;
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  port?: number;
  isRunning: boolean;
}

export interface AddMCPCommand {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  port?: number;
} 