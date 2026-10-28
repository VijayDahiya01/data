<#
Installs the Oolix Partner Agent as a Windows service, without Docker.

  .\install-windows.ps1 -ApiUrl https://api.oolix.example -Binary .\oolix-agent.exe

Run in an elevated PowerShell. It needs a PostgreSQL 13+ for the Agent's own
local store (the EnterpriseDB installer for Windows, or any server this one can
reach); the script prints the two statements that create the store's database
and login. Nothing is created in the database that holds your customers.
#>
param(
  [Parameter(Mandatory = $true)][string]$ApiUrl,
  [Parameter(Mandatory = $true)][string]$Binary,
  [string]$StoreUrl = "postgres://oolix_agent@localhost:5432/oolix_agent?sslmode=disable"
)
$ErrorActionPreference = "Stop"

$programDir = Join-Path $env:ProgramFiles "Oolix\Agent"
$dataDir = Join-Path $env:ProgramData "Oolix\Agent"
New-Item -ItemType Directory -Force -Path $programDir, $dataDir, (Join-Path $dataDir "import") | Out-Null
Copy-Item -Force $Binary (Join-Path $programDir "oolix-agent.exe")

# Only SYSTEM and Administrators may read the state folder: it holds the key
# that scrambles customer IDs and the store's password.
icacls $dataDir /inheritance:r /grant:r "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F" | Out-Null

$passwordFile = Join-Path $dataDir "store-password"
if (-not (Test-Path $passwordFile)) {
  $chars = [char[]]"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789"
  $bytes = New-Object byte[] 40
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $password = -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
  [System.IO.File]::WriteAllText($passwordFile, $password)
}

$name = "OolixAgent"
if (-not (Get-Service -Name $name -ErrorAction SilentlyContinue)) {
  New-Service -Name $name -DisplayName "Oolix Partner Agent" -StartupType Automatic `
    -BinaryPathName ('"{0}" -managed' -f (Join-Path $programDir "oolix-agent.exe")) | Out-Null
  # Restart after a failure, as systemd's Restart=on-failure does.
  sc.exe failure $name reset= 86400 actions= restart/5000/restart/5000/restart/60000 | Out-Null
}

# The service's settings, as environment variables only it sees.
$environment = @(
  "OOLIX_API_BASE_URL=$ApiUrl",
  "OOLIX_LOCAL_STORE_URL=$StoreUrl",
  "OOLIX_LOCAL_STORE_PASSWORD_FILE=$passwordFile",
  "OOLIX_STATE_DIR=$dataDir",
  "OOLIX_IMPORT_FOLDER=$(Join-Path $dataDir 'import')",
  "OOLIX_SETUP_LISTEN_ADDR=127.0.0.1:8083"
)
Set-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Services\$name" -Name Environment -Type MultiString -Value $environment

Write-Host ""
Write-Host "Installed. Before starting, create the Agent's local store on PostgreSQL (as a superuser):"
Write-Host ""
Write-Host ("  CREATE ROLE oolix_agent LOGIN PASSWORD '{0}';" -f (Get-Content -Raw $passwordFile))
Write-Host "  CREATE DATABASE oolix_agent OWNER oolix_agent;"
Write-Host ""
Write-Host "Then: Start-Service $name"
Write-Host ("The setup page password is in {0} (search for setup_password)." -f (Join-Path $dataDir "agent.log"))
Write-Host "Open http://localhost:8083 on this server."
