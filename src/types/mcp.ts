export interface MCPServerConfig {
  command: string;
  args: string[];
}

export interface Config {
  mcp_servers: Record<string, MCPServerConfig>;
}

export interface MCPCommand {
  id: string;
  name: string;
  command: string;
  args: string[];
  isRunning: boolean;
}

export type AddMCPCommand = {
  name: string;
  command: string;
  args: string[];
}; 