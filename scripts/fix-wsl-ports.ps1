<#
.SYNOPSIS
  Forward the stack's Docker ports straight to the WSL VM, bypassing WSL's own
  localhost proxy.

.DESCRIPTION
  Docker runs inside WSL, and Windows normally reaches published container ports
  through a proxy WSL maintains on localhost. That proxy is unreliable: it
  degrades (a 16ms Postgres connect becomes 100ms, which is enough to blow the
  Agent's decision budget) and it collapses outright, leaving every container
  healthy and unreachable at the same time. Restarting the container sometimes
  re-creates the mapping and sometimes does not; `wsl --shutdown` fixes it for
  minutes.

  A static port proxy to the VM's own address does not depend on that mechanism
  at all, so it survives the failure.

  The VM address changes when WSL restarts, so re-run this after a reboot.

.PARAMETER Lan
  Also listen on 0.0.0.0 so other machines on the network can reach the stack,
  and open the firewall for it. Without this, only this machine can connect.

.PARAMETER Remove
  Delete the rules this script created.

.EXAMPLE
  # Run in an ADMINISTRATOR PowerShell:
  .\scripts\fix-wsl-ports.ps1

.EXAMPLE
  .\scripts\fix-wsl-ports.ps1 -Lan      # also share on the local network
  .\scripts\fix-wsl-ports.ps1 -Remove   # undo
#>
param(
  [switch]$Lan,
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host 'This needs an Administrator PowerShell.' -ForegroundColor Yellow
  Write-Host 'Right-click PowerShell, choose "Run as administrator", then run it again.'
  exit 1
}

# Every port the stack publishes from inside WSL. The portal (3000) and API
# (4000) run natively on Windows and need no proxy.
$ports = @(
  @{ Port = 5432; Name = 'postgres' },
  @{ Port = 5433; Name = 'partner-postgres' },
  @{ Port = 6379; Name = 'redis' },
  @{ Port = 6380; Name = 'partner-redis' },
  @{ Port = 4566; Name = 'localstack' },
  @{ Port = 8081; Name = 'keycloak' }
)

$listen = if ($Lan) { '0.0.0.0' } else { '127.0.0.1' }

if ($Remove) {
  foreach ($p in $ports) {
    foreach ($addr in @('127.0.0.1', '0.0.0.0')) {
      netsh interface portproxy delete v4tov4 listenaddress=$addr listenport=$($p.Port) 2>$null | Out-Null
    }
    Write-Host ("  removed {0,-6} {1}" -f $p.Port, $p.Name)
  }
  try { Remove-NetFirewallRule -DisplayName 'Oolix stack' -ErrorAction Stop; Write-Host '  removed firewall rule' } catch { }
  Write-Host "`nDone. Windows is back to WSL's own forwarding." -ForegroundColor Green
  exit 0
}

$wslIp = (wsl.exe -d Ubuntu -u root -e hostname -I).Trim().Split(' ')[0]
if (-not $wslIp) { Write-Host 'Could not determine the WSL address. Is WSL running?' -ForegroundColor Red; exit 1 }
Write-Host "WSL VM: $wslIp`n"

foreach ($p in $ports) {
  # Clear any previous rule for this port first, on both possible addresses, so
  # re-running after a reboot replaces a stale VM address rather than colliding.
  foreach ($addr in @('127.0.0.1', '0.0.0.0')) {
    netsh interface portproxy delete v4tov4 listenaddress=$addr listenport=$($p.Port) 2>$null | Out-Null
  }
  netsh interface portproxy add v4tov4 `
    listenaddress=$listen listenport=$($p.Port) `
    connectaddress=$wslIp connectport=$($p.Port) | Out-Null
  Write-Host ("  {0,-6} {1,-18} -> {2}:{3}" -f $p.Port, $p.Name, $wslIp, $p.Port)
}

if ($Lan) {
  try { Remove-NetFirewallRule -DisplayName 'Oolix stack' -ErrorAction SilentlyContinue } catch { }
  New-NetFirewallRule -DisplayName 'Oolix stack' -Direction Inbound -Protocol TCP `
    -LocalPort 3000, 4000, 5432, 5433, 6379, 6380, 4566, 8081 `
    -Action Allow -Profile Private | Out-Null
  Write-Host "`n  firewall: inbound allowed on the private profile"
}

Write-Host "`nDone." -ForegroundColor Green
Write-Host 'Re-run this after a reboot — the WSL address changes.'
