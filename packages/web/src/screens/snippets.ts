/**
 * How each assistant connects to PureStrings' MCP server with its own token, in each one's own format (from
 * OpenClaw's, Hermes Agent's and Claude Code's docs, November 2026).
 */
export interface Snippet {
  readonly name: string;
  /** Where it goes, in a line. */
  readonly where: string;
  readonly text: string;
}

export function snippets(url: string, token: string): Snippet[] {
  return [
    {
      name: "OpenClaw",
      where: "Add this to ~/.openclaw/openclaw.json (the Gateway reloads it), then check it with: openclaw mcp doctor purestrings --probe",
      text: JSON.stringify({ mcp: { servers: { purestrings: { url, transport: "streamable-http", headers: { Authorization: `Bearer ${token}` } } } } }, null, 2),
    },
    {
      name: "Hermes Agent",
      where: "Add this to ~/.hermes/config.yaml, then run /reload-mcp (or restart Hermes) and check it with: hermes mcp test purestrings",
      text: `mcp_servers:\n  purestrings:\n    url: "${url}"\n    headers:\n      Authorization: "Bearer ${token}"`,
    },
    {
      name: "Claude Code",
      where: "Run this once in a terminal (add --scope user to have it in every project).",
      text: `claude mcp add --transport http purestrings ${url} --header "Authorization: Bearer ${token}"`,
    },
    {
      name: "Any MCP client",
      where: "Clients that take MCP servers as JSON (Claude Desktop, Cursor) take it like this.",
      text: JSON.stringify({ mcpServers: { purestrings: { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2),
    },
  ];
}
