$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node.js LTS first.' }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'Install npm with Node.js first.' }
if (Test-Path 'mobile/package.json') {
  Write-Host 'mobile/package.json already exists; refusing to overwrite it.'
  exit 0
}
$seed = Join-Path $PSScriptRoot 'expo-seed-temp'
if (Test-Path $seed) { throw 'expo-seed-temp exists. Delete it or choose a fresh extraction folder.' }
Write-Host 'Creating official Expo TypeScript baseline...'
& npx.cmd create-expo-app@latest expo-seed-temp --template blank-typescript
if ($LASTEXITCODE -ne 0) { throw 'Expo initialization failed.' }
$mobile = Join-Path $PSScriptRoot 'mobile'
# Copy generated native-compatible Expo metadata. Keep our pre-created source files.
foreach ($f in @('package.json','package-lock.json','tsconfig.json','.gitignore','app.json','index.ts')) {
  $src = Join-Path $seed $f
  if (Test-Path $src) { Copy-Item $src (Join-Path $mobile $f) -Force }
}
if (Test-Path (Join-Path $seed 'assets')) {
  Copy-Item (Join-Path $seed 'assets') $mobile -Recurse -Force
}
Write-Host 'Installing Expo-compatible camera and TTS packages...'
Push-Location $mobile
try {
  & npm.cmd install
  if ($LASTEXITCODE -ne 0) { throw 'npm install failed.' }
  & npx.cmd expo install expo-camera expo-speech
  if ($LASTEXITCODE -ne 0) { throw 'expo install failed.' }
} finally { Pop-Location }
Remove-Item $seed -Recurse -Force
Write-Host 'Ready. Run: cd mobile ; npx expo start'
Write-Host 'Expo Go supports the initial camera+speech app, not the future native voice recognition module.'
