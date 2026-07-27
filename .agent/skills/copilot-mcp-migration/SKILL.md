---
name: copilot-mcp-migration
description: Best practices and automated workflow for GitHub Copilot CLI configuration migration, MCP server setup (Firecrawl, Filesystem, Playwright, Google Workspace), and session management. Activate this skill when managing AI tool configurations, MCP servers, or migrating Copilot/Antigravity settings.
---

# GitHub Copilot CLI & MCP Server Migration & Setup Skill

This skill provides a structured workflow for configuring, backing up, and migrating AI development tools and Model Context Protocol (MCP) servers.

## 1. Quick Reference Commands
- `/env` : Check active instructions, MCP tools, and skills.
- `/mcp` : Manage and list MCP servers.
- `/skills` : Check installed skills.
- `/instructions` : Check global and repo-level instruction files.

## 2. Key Configuration File Locations
- **Copilot Global Instructions**: `%USERPROFILE%\.copilot\copilot-instructions.md`
- **MCP Config File**: `%USERPROFILE%\.copilot\mcp-config.json`
- **Session State**: `%USERPROFILE%\.copilot\session-state\`
- **Repo Instructions**: `.github\copilot-instructions.md` or `AGENTS.md` / `GEMINI.md` / `CLAUDE.md`

## 3. Supported MCP Servers & Setup Specifications

### 🔍 Firecrawl (Web Scraping & Markdown Summary)
```json
"firecrawl": {
  "command": "npx",
  "args": ["-y", "firecrawl-mcp"],
  "env": {
    "FIRECRAWL_API_KEY": "<API_KEY>"
  }
}
```

### 📁 Filesystem (Access Local Directories)
```json
"filesystem": {
  "command": "npx",
  "args": [
    "-y",
    "@modelcontextprotocol/server-filesystem",
    "C:\\Users\\<USERNAME>\\Desktop",
    "C:\\Users\\<USERNAME>\\Documents",
    "C:\\Users\\<USERNAME>\\Downloads"
  ]
}
```

### 🌐 Playwright (Browser Automation)
```json
"playwright": {
  "command": "npx",
  "args": ["-y", "@playwright/mcp"]
}
```

### 🔗 Google Workspace (Gmail, Calendar, Drive, Sheets)
```json
"google-workspace": {
  "command": "gws",
  "args": ["mcp", "serve"],
  "env": {}
}
```

### 📓 NotebookLM (Search, Query & Manage NotebookLM)
```json
"notebooklm": {
  "command": "notebooklm-mcp",
  "args": []
}
```


## 4. Execution Principles for AI Agents
1. **Interactive Prompting**: Always prompt the user before modifying MCP configuration or paths.
2. **Path Verification**: Validate Windows escape slashes (`\\`) or forward slashes (`/`) in JSON files.
3. **Restart Requirement**: Remind the user to restart the CLI or IDE session after updating `mcp-config.json`.
