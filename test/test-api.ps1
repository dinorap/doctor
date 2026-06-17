# Test script for Chromium Profile Manager API

Write-Host "Testing Chromium Profile Manager API..." -ForegroundColor Cyan

# Test 1: Create a profile
Write-Host ""
Write-Host "1. Creating a new profile..." -ForegroundColor Yellow
$createBody = @{
    name = "Test Profile 1"
    description = "First test profile"
} | ConvertTo-Json

try {
    $createResponse = Invoke-WebRequest -Uri "http://localhost:3000/api/profiles/create" -Method POST -Headers @{"Content-Type"="application/json"} -Body $createBody
    $createResult = $createResponse.Content | ConvertFrom-Json
    Write-Host "Success: Profile created successfully!" -ForegroundColor Green
    Write-Host "Profile ID: $($createResult.data.id)" -ForegroundColor Green
    $profileId = $createResult.data.id
} catch {
    Write-Host "Error: Failed to create profile: $_" -ForegroundColor Red
    exit 1
}

# Test 2: List all profiles
Write-Host ""
Write-Host "2. Listing all profiles..." -ForegroundColor Yellow
try {
    $listResponse = Invoke-WebRequest -Uri "http://localhost:3000/api/profiles" -Method GET
    $listResult = $listResponse.Content | ConvertFrom-Json
    Write-Host "Success: Found $($listResult.data.Count) profile(s)" -ForegroundColor Green
    $listResult.data | ForEach-Object {
        Write-Host "  - $($_.name) (ID: $($_.id))" -ForegroundColor Gray
    }
} catch {
    Write-Host "Error: Failed to list profiles: $_" -ForegroundColor Red
}

# Test 3: Open the profile (launch browser with extension)
Write-Host ""
Write-Host "3. Opening profile in Chromium browser..." -ForegroundColor Yellow
Write-Host "   This will launch a Chromium browser with the extension loaded." -ForegroundColor Cyan
Write-Host "   Press Ctrl+C to stop the test after verifying the browser." -ForegroundColor Cyan

$openBody = @{
    id = $profileId
    openFlow = $false
} | ConvertTo-Json

try {
    $openResponse = Invoke-WebRequest -Uri "http://localhost:3000/api/profiles/open" -Method POST -Headers @{"Content-Type"="application/json"} -Body $openBody
    $openResult = $openResponse.Content | ConvertFrom-Json
    Write-Host "Success: Browser opened successfully!" -ForegroundColor Green
    Write-Host "Session ID: $($openResult.data.sessionId)" -ForegroundColor Green
    Write-Host "Extension ID: $($openResult.data.extensionId)" -ForegroundColor Green
    Write-Host ""
    Write-Host "Browser is now running. Check if the extension is loaded." -ForegroundColor Cyan
    Write-Host "Press Enter to continue with cleanup..." -ForegroundColor Yellow
    Read-Host
} catch {
    Write-Host "Error: Failed to open profile: $_" -ForegroundColor Red
    Write-Host "Error details: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host ""
Write-Host "Test completed!" -ForegroundColor Cyan
