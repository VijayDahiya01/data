@echo off
REM ---------------------------------------------------------------------------
REM Holds a WSL client session open so the Ubuntu distro (and the Docker daemon
REM inside it) is not torn down while idle. Without this, WSL shuts the VM down
REM shortly after the last client detaches, restarting every container and
REM dropping open Postgres/Redis connections.
REM
REM Started automatically by `pnpm infra:up`. Close the window, or run
REM `wsl --shutdown`, to stop it.
REM ---------------------------------------------------------------------------
title oolix-wsl-keepalive
echo Holding the WSL2 distro open for Oolix local development.
echo Close this window to release it.
wsl.exe -d Ubuntu -u root -e sleep infinity
