# MCNetwork on a Windows Server

## What you need

- **Node.js 22 or newer** (the LTS installer from nodejs.org).
- The release folder (`npm run package` builds it, or take the zip): `mcnetwork.js`, `web/`, `agent/jars/`, `mcli.js`, `start.bat`.
- Internet access for the first setup: MCNetwork downloads Paper and Velocity, and MCLI downloads a matching Java (Eclipse Temurin) into the server's own folder. Nothing is installed system-wide.

## First start

1. Unpack the folder, for example to `C:\MCNetwork`.
2. Double-click `start.bat` (or run it in PowerShell). Servers and settings live in `C:\MCNetwork\data`.
3. Open `http://localhost:8080` on the server and run the setup wizard.

## Reaching the dashboard from your own PC

By default the dashboard only listens on the server itself. To use it from another machine, edit `data\mcnetwork.json`:

```json
"http": { "host": "0.0.0.0", "port": 8080, "token": "a-long-random-secret" }
```

MCNetwork refuses to listen on a non-local address without a token. The connection is plain HTTP, so keep it on a trusted network or VPN, or put an HTTPS reverse proxy in front. Let only your admin addresses reach the port:

```powershell
New-NetFirewallRule -DisplayName "MCNetwork dashboard" -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow -RemoteAddress 203.0.113.10
```

## Windows Firewall: only the proxy port

Players only ever connect to the **proxy** (25565 by default). The game servers listen on `127.0.0.1` and need no rule. On the **Ports** page, step 2 reads the real firewall state with PowerShell (this works the same on German and other Windows versions), tells whether an enabled inbound rule already allows the port, and otherwise shows the command to run in an **elevated** PowerShell:

```powershell
New-NetFirewallRule -DisplayName "MCNetwork 25565" -Direction Inbound -Protocol TCP -LocalPort 25565 -Action Allow
# or, the older way:
netsh advfirewall firewall add rule name="MCNetwork 25565" dir=in action=allow protocol=TCP localport=25565
```

MCNetwork never changes the firewall itself. Leave `ports.upnp` at `false` on a server: UPnP is for home routers. Step 4 (the check from the internet) works from anywhere and sends your public address and the port to mcsrvstat.us only when you click.

To see what listens: `Get-NetTCPConnection -State Listen | Where-Object LocalPort -in 25565,30066,30067`.

## Running it as a service

**With NSSM** (nssm.cc), in an elevated prompt:

```
nssm install MCNetwork "C:\Program Files\nodejs\node.exe"
nssm set MCNetwork AppParameters "C:\MCNetwork\mcnetwork.js --data C:\MCNetwork\data"
nssm set MCNetwork AppDirectory C:\MCNetwork
nssm set MCNetwork Start SERVICE_AUTO_START
nssm set MCNetwork AppStopMethodConsole 60000
nssm start MCNetwork
```

NSSM stops the service with Ctrl+C, which MCNetwork answers by stopping every server gracefully (worlds are saved) before it exits; `AppStopMethodConsole` gives that up to 60 seconds. **Task Scheduler** also works: a task "At startup", "Run whether user is logged on or not", action `C:\MCNetwork\start.bat`.

To stop it from a script (for example before patching and a reboot):

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:8080/api/shutdown -Headers @{ Authorization = 'Bearer a-long-random-secret' }
```

If the daemon is ever killed hard, each MCLI sees its input close and stops its server gracefully on its own; give it a little time before powering off.

## Good to know on Windows

- **Ports Windows has reserved** (Hyper-V, WSL, Docker) cannot be used: `netsh int ipv4 show excludedportrange protocol=tcp`. MCNetwork picks free ports from 30066 upward and skips ports it cannot bind; if you choose a port yourself and the server fails to start, look at that list.
- **Locked files:** a running server holds its jars. MCNetwork updates the agent plugin only while a server is stopped, and moving or importing a folder needs the server to be stopped. The messages say so.
- **Server ids** may not be `con`, `prn`, `aux`, `nul`, `com1`-`com9` or `lpt1`-`lpt9` (Windows reserves them as folder names).
- **Long paths:** deep world folders can exceed 260 characters; enable long paths (`LongPathsEnabled` = 1) if you see odd copy errors.
- **Antivirus:** exclude the `data` folder (or at least the world folders) from real-time scanning; it costs a lot of performance and can lock files.
- **Importing:** give full paths such as `D:\Minecraft\survival` (or `\\server\share\mc`). *Copy* is the safe default; *move* only works on the same drive.

## What has been checked, and what not

Tested on Linux with real Paper and Velocity, plus tests that simulate Windows: the firewall detection with PowerShell and `netsh` answers (including German and other languages), path handling with drive letters and backslashes, Windows line endings in `server.properties` and `velocity.toml`, reserved folder names and locked files. It has **not** yet been run on a real Windows Server: do the first setup there with the wizard, and check the Ports page (step 2 should say whether a rule exists).
