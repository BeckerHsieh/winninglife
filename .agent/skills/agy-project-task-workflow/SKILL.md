---
name: agy-project-task-workflow
description: Best practices for AGY project file structuring, global/project MCP management, and 4-tier Markdown task tracking (AGENTS.md, implementation_plan.md, task.md, walkthrough.md). Activate this skill when setting up new AGY projects, defining project handbooks, or tracking multi-step task execution.
---

# AGY Project Structuring & Task Tracking Skill

This skill defines the canonical project layout and 4-tier Markdown task tracking system for Google Antigravity (AGY).

## 1. Standard Project Directory Structure
```text
my-project/
├── AGENTS.md                         # 🤖 Project Handbook (Architecture, Test Commands, Rules)
├── .agent/                           # 🧠 AGY Workspace Specifications
│   ├── skills/                       #    Workspace Skills
│   │   └── <skill-name>/SKILL.md
│   └── rules/                        #    Workspace Rules
├── .vscode/
│   └── mcp.json                      # 🔌 Workspace MCP Server Config
├── src/                              # 💻 Source Code
└── tests/                            # 🧪 Tests
```

## 2. Global vs Project Configuration Scope
- **Global MCP Config**: `%USERPROFILE%\.copilot\mcp-config.json` & `%USERPROFILE%\.gemini\antigravity\mcp_config.json`
- **Global Rules**: `%USERPROFILE%\.gemini\antigravity\rules\user-rules.md`
- **Global Skills**: `%USERPROFILE%\.gemini\antigravity\skills\`

## 3. The 4-Tier Markdown Task Document System

| File | Purpose | Timing |
| :--- | :--- | :--- |
| **`AGENTS.md`** | Universal Project Handbook & Guidelines | Permanent Repository Handbook |
| **`implementation_plan.md`** | Architecture Proposal & Verification Plan | Pre-execution Phase |
| **`task.md`** | Step-by-step Task Checklist & `[x]` State Tracking | Execution Phase |
| **`walkthrough.md`** | Execution Summary & Evidence Verification | Post-execution Phase |

## 4. `task.md` Real-Time State Tracking Rules
- Use `[ ]` for pending tasks, `[/]` for in-progress, `[x]` for completed.
- Maintain granularity to 3-5 minute sub-tasks.
- Ensure state persistence across turn boundaries and background command execution.
