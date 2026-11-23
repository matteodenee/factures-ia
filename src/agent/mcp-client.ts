import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

export async function connectMcp() {
  const client = new Client({
    name: "factures-ia-agent",
    version: "1.0.0"
  });

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "src/mcp/server.ts"],
    cwd: process.cwd()
  });

  await client.connect(transport);

  return client;
}
