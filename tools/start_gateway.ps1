# Starts the gateway and a Cloudflare quick tunnel, then publishes the new tunnel URL to config.json.
# Needs: %LOCALAPPDATA%\subtitle-gateway\ with gateway.py, gateway.json and cloudflared.exe; gh logged in.
$ErrorActionPreference = "Stop"
$dir = Join-Path $env:LOCALAPPDATA "subtitle-gateway"
$repo = "UFO0506/subtitle-studio-demo"

# Stop only the copies this script started earlier.
foreach ($p in Get-CimInstance Win32_Process) {
    if ($p.CommandLine -and $p.CommandLine -like "*subtitle-gateway*" -and $p.ProcessId -ne $PID -and
        ($p.Name -eq "cloudflared.exe" -or $p.Name -like "python*")) {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

$python = (Get-Command python).Source
Start-Process -WindowStyle Hidden -FilePath $python -ArgumentList "`"$dir\gateway.py`"" -WorkingDirectory $dir

$log = Join-Path $dir "cloudflared.log"
if (Test-Path $log) { Remove-Item $log -Force }
Start-Process -WindowStyle Hidden -FilePath "$dir\cloudflared.exe" -WorkingDirectory $dir `
    -ArgumentList "tunnel --no-autoupdate --url http://127.0.0.1:8096 --logfile `"$log`""

$url = $null
for ($i = 0; $i -lt 60 -and -not $url; $i++) {
    Start-Sleep -Seconds 1
    if (Test-Path $log) {
        $hit = Select-String -Path $log -Pattern "https://[a-z0-9-]+\.trycloudflare\.com" | Select-Object -First 1
        if ($hit) { $url = $hit.Matches[0].Value }
    }
}
if (-not $url) { throw "Tunnel URL not found. See $log" }

$content = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((@{ gateway = $url } | ConvertTo-Json -Compress)))
$sha = gh api "repos/$repo/contents/config.json" --jq .sha
gh api -X PUT "repos/$repo/contents/config.json" -f "message=Update gateway address" -f "content=$content" -f "sha=$sha" --silent
Write-Output "Gateway online. The website picks up the new address in about a minute."
