# Lens AI for Android

**Deadline: 27 November 2026.** Target platform: one tested Android smartphone. Windows development computer.

## Document workflow

Version 1.5 uses Gemini Live's Aoede voice for app speech, including framing directions, status messages, scene descriptions and answers. OpenCV measures alignment and the app asks Gemini Live to say the measured direction. The app rejects delayed framing audio when the current measurement calls for a different cue. On Android devices with echo cancellation, the audio module clears speaker playback when it detects incoming speech and passes the utterance on to Gemini.

Gemini Live starts in the foreground with Android microphone permission and a visible privacy notice. It reconnects when the app returns to the foreground or after a connection failure. **Stop listening** survives relaunches and updates. The PC relays 16 kHz microphone audio and up to one portrait JPEG preview per second to Gemini while the camera is open. [Live API formats and frame rate](https://aistudio.google.com/docs/live-api/capabilities)

- Say **What can you see?** for a fresh scene check, **Help me align this document** for the current geometry cue, or **Capture** at any time while the camera is ready. After capture, the description includes one relevant follow-up question. Ask natural questions about the photo. Each answer is grounded through the existing photo and OCR endpoint before narration.
- Speak over Gemini to interrupt narration on devices with echo cancellation. **Stop speaking** is also available in **More actions**. On devices without echo cancellation, microphone input pauses during playback to prevent feedback.
- **Close camera** stops video and leaves foreground listening available. **Stop listening** stops live audio and automatic preview uploads. **Use local framing** keeps preview images on the PC for OpenCV. When Live is unavailable, the app shows text and can accept commands through Android speech recognition while it reconnects. Leaving the foreground stops the Live session.

- Use **Resume listening** to turn listening on again after stopping it.
- Android samples the rear-camera preview at up to four frames a second. CameraX applies portrait rotation and a shared 3:4 crop. FastAPI measures document corners, center, distance, clipping, tilt, and sharpness. The app needs at least three matching aligned samples spanning at least 550 ms before saying **Alignment fixed. Document ready. Say capture.**
- Gemini Live sees the preview stream and can describe an unclear scene. OpenCV supplies measured corrections and determines readiness using corners and sharpness. **Use local framing** turns off the Live preview stream. **Use Lens AI framing** turns it back on. This choice lasts until the app restarts.
- **Repeat guidance** and **Check alignment** read the latest measurement. **Capture anyway** is available when the document cannot be located. Unchanged corrections wait at least 10 seconds before repeating. A meaningful move toward center can prompt a shorter update.
- The screen uses large, high-contrast controls. Expand **More actions** for typed questions, repeat, privacy settings and secondary camera controls.
- **Capture** runs local OCR and Gemini analysis of the actual photo, then speaks the description. **Capture text only** runs OCR without sending the photo to Gemini. Touch controls and typed questions are available.
- The demo uses a rectangular, light-colored document on a contrasting surface with good lighting.

## Windows setup (PowerShell)

Install Node.js, Python 3.11 or newer, a JDK, Android SDK tools, and ADB. The project includes the Expo SDK 58 manifest and npm lockfile.

```powershell
cd backend
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item .env.example .env -NoClobber
```

Set `GEMINI_API_KEY` privately in `backend/.env`. Use `GEMINI_MODEL` to override the default `gemini-3.5-flash-lite` if your Google project uses a different image-capable model with structured output support.

`GEMINI_LIVE_MODEL` defaults to `gemini-3.8-live`. The backend opens Google's WebSocket, requests context compression and accepts session resumption handles when Google sends a GoAway message. The app falls back to Android recognition and retries when Live drops. [Live model](https://aistudio.google.com/docs/models/gemini-3.8-live) · [Live session management](https://aistudio.google.com/docs/live-api/session-management)

Start FastAPI from the backend directory.

```powershell
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8002 --ws-max-size 384000
```

In a separate terminal, connect the unlocked phone over USB, enable USB debugging and allow the PC.

```powershell
$adb = Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe'
& $adb devices
& $adb reverse tcp:8000 tcp:8002
curl.exe --fail "http://127.0.0.1:8002/health"
```

The phone connects to its loopback port 8000. ADB forwards that connection to the Windows loopback backend on port 8002. Reapply the mapping after reconnecting if needed. The PC needs internet access for Gemini, and Android speech recognition may also require internet access on the phone.

## Pair with a hosted server

1. On the host, set `LENS_REMOTE_MODE=1`, `LENS_ACCESS_KEY` and `GEMINI_API_KEY` as process environment variables. Generate a separate access key with `python -c "import secrets; print(secrets.token_urlsafe(32))"`. Keep the AI API key on the host. The generated access key is the one you paste into Lens AI.
2. Serve the backend through HTTPS and WSS. Keep `/health` available for the host's health check. `POST /pair`, image and document endpoints, and `/live` require the server access key in the Authorization header. In hosted mode, requests fail closed when the key is missing or invalid. For local USB development, run the loopback command above with both Lens access settings unset.
3. On Android, open Lens AI 1.6 or newer and choose **More actions → Pair with a server**. Enter the host's HTTPS address, paste the access key and select **Pair phone**. The device stores the key encrypted with Android Keystore. Users can enter a new hosted address without rebuilding the APK. An optional `EXPO_PUBLIC_API_BASE_URL` supplies a default address when building. The access key and AI API key belong outside that variable. [Android Keystore](https://developer.android.com/privacy-and-security/keystore) · [Expo environment variables](https://docs.expo.dev/guides/environment-variables/)
4. To disconnect a phone, choose **Change server pairing → Use USB connection**. To revoke the key at the server, generate a new access key and restart the hosted backend. Pair the phone again with the new key.

`POST /alignment` returns the quick OpenCV measurement. `POST /alignment/vision` accepts portrait JPEG or PNG samples up to 512 KiB, applies EXIF orientation, and sends Gemini a JPEG with a maximum side of 480 pixels. It returns the final action, source, validated assessment, and timing or retry status. The schema uses categorical evidence and does not report numeric confidence.

The mobile build setting `EXPO_PUBLIC_ALIGNMENT_INTERVAL_MS` and backend setting `GEMINI_ALIGNMENT_INTERVAL_MS` default to 2500 ms. Set both to the same value between 2000 and 15000. If Gemini takes longer, sampling waits for the outstanding request while OpenCV keeps running. The backend allows up to 6.5 seconds for the Gemini response, waits 10 seconds after a transient failure, and waits 60 seconds after quota exhaustion. The mobile client cancels outstanding alignment work when leaving framing or switching modes. Requests already sent to Google may finish after the phone disconnects. Set `GEMINI_ALIGNMENT_ENABLED=false` in `backend/.env` for PC-only framing. `GEMINI_ALIGNMENT_MODEL` optionally overrides the model for alignment alone.

If framing reports a problem, leave the camera open while it retries. The app distinguishes a sideways or unreadable camera sample, a slow backend, and a lost USB connection. **Check alignment** repeats the latest result or recovery cue. **Capture anyway** is available while framing recovers.

## Native voice commands and APK

With the Android SDK and a compatible JDK installed, build a standalone test APK locally. It includes the JavaScript bundle and can run without Metro or shared Wi-Fi.

```powershell
cd mobile
npm.cmd ci
npx.cmd expo prebuild --platform android --no-install --no-clean
cd android
.\gradlew.bat :app:assembleRelease
```

The local test APK is generated at `mobile/android/app/build/outputs/apk/release/app-release.apk`. The npm postinstall script integrates Android preview sampling and portrait rotation with Expo SDK 58. Run `node scripts/configure-camera.cjs` in `mobile` before building if dependencies are already installed. Devices that cannot bind the preview analyzer use slower still-photo sampling. For an Expo development client with live reload or a cloud-built APK, use EAS.

```powershell
cd mobile
npx expo install expo-dev-client
npx eas-cli@latest login
npx eas-cli@latest build:configure
npx eas-cli@latest build --platform android --profile development
```

For installable APK, `eas.json` contains the `preview` profile with `android.buildType: apk`:

```powershell
npx eas-cli@latest build --platform android --profile preview
```

EAS cloud builds require an Expo account and internet access. Check build usage and quota before starting a cloud build.

## Demo and verification

1. Open **Lens AI**. Allow microphone access on the first launch. When the app shows **Lens AI is listening**, say **Open camera**. Grant camera permission if prompted.
2. Start with a non-sensitive receipt on a contrasting surface. Keep the whole receipt within the portrait preview. From center, move the phone right, left, down, and up in separate trials. Pause after each move. Expect the app to say left, right, up, and down respectively. Return to center between trials. Test clipping, distance, blur, and tilt, then hold still until you hear **Alignment fixed. Document ready. Say capture.**
3. Say **Capture** and listen to the automatic Gemini description. Say **Read this** for the local OCR text, **Describe this** to hear the description again, or **Shorter explanation** for a concise summary.
4. After the listening cue, ask **What is the total amount?** Say the question directly, or use **Ask question** first for a dedicated prompt. The app speaks the live answer and displays any verified OCR excerpt.
5. Say **Scan again** to return to framing or **Go back** to return home. Say **Stop listening** during a listening turn to disable the microphone until you choose **Resume listening**. Accessible controls remain available. Use the **Stop speaking** control to interrupt active playback. Voice commands are accepted in the listening intervals between spoken replies.

`alignment vision=ok` records the framing latency, source, and action. `Gemini analyze success` and `Gemini ask success` identify live upstream calls. The Android speech service may sound its own cue when each short listening turn begins.

For a development run, set `ALIGNMENT_DEBUG=1` before starting Uvicorn to log frame dimensions, normalized bounding box, center, offsets, blur score, clipping, distance flags, selected action, and processing time. Build with `EXPO_PUBLIC_ALIGNMENT_DEBUG=1` to log camera sampling rate, average frame age when analyzed, and the spoken framing cue in Android logcat. These diagnostics omit images and document text.

Run backend tests from `backend`. The optional live test makes real Gemini requests with a non-sensitive receipt fixture.

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
$env:RUN_LIVE_GEMINI_TESTS = '1'
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
Remove-Item Env:RUN_LIVE_GEMINI_TESTS
```

Run the guidance and speech regressions from `mobile` with `node --test tests/guidance-and-speech.test.cjs`.

While the backend is running, run `.\.venv\Scripts\python.exe -m tests.live_smoke` from `backend` for the real Live bridge smoke test. It uses generated command audio and a synthetic receipt. It records setup timing and verifies the command, scene, and grounded narration paths.

Use `evaluation/acceptance-checklist.md` for physical camera directions, blind-use controls, permission and connectivity recovery, and final evidence.

## Notes

`docs/Everyday_Lens_AI_Design_Document.md` is the original specification. The app keeps the current photo in its cache for follow-up questions and removes it on rescan, when returning home, or after ten minutes. Framing samples are discarded after each check. The backend processes uploads temporarily and logs status without image, OCR, or question content. Use a non-sensitive document for the demo.
