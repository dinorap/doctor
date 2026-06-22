$sw = [Diagnostics.Stopwatch]::StartNew()
try {
    $body = @{
        input_type = "topic"
        topic = "xin chao"
        language = "vi"
        duration_minutes = 0.1
        temperature = 0.7
        no_voice = $false
        no_music = $false
    } | ConvertTo-Json -Compress

    Write-Host "Testing /api/scripts/generate with topic='xin chao'..."
    $resp = Invoke-RestMethod -Uri "http://localhost:3000/api/scripts/generate" -Method POST -ContentType "application/json" -Body $body -TimeoutSec 90
    Write-Host "SUCCESS in $($sw.ElapsedMilliseconds)ms:"
    $resp | ConvertTo-Json -Depth 5 | Write-Host
} catch {
    Write-Host "ERROR in $($sw.ElapsedMilliseconds)ms: $($_.Exception.Message)"
    if ($_.Exception.Response) {
        Write-Host "STATUS: $($_.Exception.Response.StatusCode)"
        try {
            $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
            $body = $reader.ReadToEnd()
            Write-Host "BODY: $body"
        } catch {}
    }
} finally {
    $sw.Stop()
}
