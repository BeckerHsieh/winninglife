# import.ps1
param()
$ErrorActionPreference = "Stop"
$PkgDir = $PSScriptRoot
$CopilotDir = "$env:USERPROFILE\.copilot"

Write-Host "=== Copilot Import ===" -ForegroundColor Cyan

# --- read .env ---
$envFile = "$PkgDir\.env"
if (-not (Test-Path $envFile)) {
    Write-Host "[ERROR] .env not found. Copy .env.example to .env and fill in values." -ForegroundColor Red
    exit 1
}

$envVars = @{}
Get-Content $envFile | Where-Object { $_ -notmatch "^\s*#" -and $_ -match "=" } | ForEach-Object {
    $parts = $_ -split "=", 2
    $envVars[$parts[0].Trim()] = $parts[1].Trim()
}

$apiKey = $envVars["FIRECRAWL_API_KEY"]
$d1     = $envVars["FILESYSTEM_DIR_1"]
$d2     = $envVars["FILESYSTEM_DIR_2"]
$d3     = $envVars["FILESYSTEM_DIR_3"]

if (-not $apiKey -or $apiKey -like "*xxxx*") {
    Write-Host "[ERROR] FIRECRAWL_API_KEY not set in .env" -ForegroundColor Red
    exit 1
}

Write-Host "Settings:" -ForegroundColor Gray
Write-Host "  API Key: $($apiKey.Substring(0,8))..." -ForegroundColor Gray
Write-Host "  DIR 1:   $d1" -ForegroundColor Gray
Write-Host "  DIR 2:   $d2" -ForegroundColor Gray
Write-Host "  DIR 3:   $d3" -ForegroundColor Gray
Write-Host ""

# --- backup existing ---
New-Item -ItemType Directory -Path $CopilotDir -Force | Out-Null
$hasExisting = (Test-Path "$CopilotDir\mcp-config.json") -or (Test-Path "$CopilotDir\copilot-instructions.md")
if ($hasExisting) {
    $backupDir = "$CopilotDir\backup_$(Get-Date -Format 'yyyyMMdd_HHmmss')"
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
    @("mcp-config.json","copilot-instructions.md","settings.json") | ForEach-Object {
        $f = "$CopilotDir\$_"
        if (Test-Path $f) { Copy-Item $f $backupDir }
    }
    Write-Host "[OK] Backup saved to $backupDir" -ForegroundColor Green
}

# --- copy instructions & settings ---
Copy-Item "$PkgDir\settings\copilot-instructions.md" "$CopilotDir\copilot-instructions.md" -Force
Write-Host "[OK] copilot-instructions.md" -ForegroundColor Green

Copy-Item "$PkgDir\settings\settings.json" "$CopilotDir\settings.json" -Force
Write-Host "[OK] settings.json" -ForegroundColor Green

# --- generate mcp-config.json from template (modify object directly) ---
$tpl = Get-Content "$PkgDir\settings\mcp-config.template.json" -Raw | ConvertFrom-Json

$tpl.mcpServers.firecrawl.env.FIRECRAWL_API_KEY = $apiKey

$newArgs = [System.Collections.Generic.List[string]]::new()
$newArgs.Add("-y")
$newArgs.Add("@modelcontextprotocol/server-filesystem")
if ($d1) { $newArgs.Add($d1) }
if ($d2) { $newArgs.Add($d2) }
if ($d3) { $newArgs.Add($d3) }
$tpl.mcpServers.filesystem.args = $newArgs.ToArray()

$tpl | ConvertTo-Json -Depth 10 | Set-Content "$CopilotDir\mcp-config.json" -Encoding UTF8
Write-Host "[OK] mcp-config.json" -ForegroundColor Green

# --- validate JSON ---
try {
    Get-Content "$CopilotDir\mcp-config.json" -Raw | ConvertFrom-Json | Out-Null
    Write-Host "[OK] JSON validation passed" -ForegroundColor Green
} catch {
    Write-Host "[ERROR] JSON validation failed: $_" -ForegroundColor Red
}

Write-Host ""
Write-Host "Import complete! Restart Copilot CLI and run /env to verify." -ForegroundColor Cyan
