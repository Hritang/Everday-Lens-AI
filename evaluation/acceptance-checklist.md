# End-to-end acceptance checklist

- [x] Camera opens on selected Android phone
- [ ] Permissions denied/retry spoken appropriately
- [ ] TalkBack labels all actionable elements
- [ ] Alignment instructions are correct when verified physically
- [x] Speech capture command works in the native APK
- [ ] App's own speech does not activate voice commands
- [ ] Captured text can be read aloud
- [ ] Actual phone photo reaches `/analyze`, Gemini responds successfully, and the app displays and speaks the description
- [ ] Spoken “Ask question” starts a second listening session, a dictated question reaches `/ask`, and a grounded Gemini answer is spoken
- [x] A dictated question in the native APK reaches Gemini, appears with its answer, and triggers speech playback
- [ ] An illegible or absent detail produces a usable uncertainty response
- [ ] Gemini failure leaves the OCR text available and speaks an actionable error
- [ ] Error, privacy and uncertainty explained
- [x] APK installed and independently launched

## Demo run

Use a non-sensitive printed receipt or notice on a contrasting surface. Enable TalkBack before the accessibility pass. Open the camera by voice, say **Guide me**, and move the phone according to the cue. Test left, right, up, down, blur, and clipping. Say **Capture**, listen to OCR, then say **Describe image**. Say **Ask question**, wait for the second listening cue, and ask about a visible detail. Repeat with a question the page cannot answer. Verify that backend logs show successful Gemini `analyze` and `ask` requests. Record the phone model, observed results and latency, with any camera images or other participant material included only with permission.

## Test log for 21 November 2026

| Check | Result |
| --- | --- |
| Release build and installation | Signed APK 1.1.0 built and opened on the connected SM-M326B. |
| USB, camera and OCR | The phone reached FastAPI over ADB reverse. Actual rear-camera frames and a capture returned HTTP 200 from `/alignment` and `/ocr`. A test scene without readable text displayed the recovery message. |
| Native microphone | The phone reached the listening state. Local command tests passed separately for command routing, dictated question routing, cancellation, and permission denial. |
| Gemini API with test receipt | Live `/analyze` and `/ask` tests passed with Gemini 3.5 Flash-Lite. Real OCR read the fixture's total. Gemini returned the same total in response to the test question. |
| Phone photo and Gemini | The phone displayed the real AI description after `/analyze` returned HTTP 200. That request took about 4.1 seconds at Gemini. |
| Model recovery | Gemini 3.1 Flash-Lite returned intermittent upstream errors during testing and succeeded on one phone request. The demo backend was configured to use the model that passed both live API tests. |
| Awaiting on-device verification | Dictated Q&A through the full phone workflow, audible playback confirmation, TalkBack, and physical movement validation. |

## Test log for 22 November 2026

- Restarted FastAPI and verified HTTP 200 from the physical phone over USB.
- Asked the running backend for a phone number that was absent from a non-sensitive test receipt. Gemini 3.5 Flash-Lite said it was absent, flagged the answer as uncertain, and returned no supporting excerpt.
- Android recognized “Open camera” and “Capture.” The resulting phone photo reached `/ocr` with HTTP 200.
- The question displayed in the Android app matched a native Android speech-recognition result. The phone's `/ask` request returned HTTP 200 after a 4.3-second Gemini 3.5 Flash-Lite call. The app displayed the AI answer, and Android logged speech playback routed to the speaker.

## Voice-first APK 1.2.0 acceptance on 23 November 2026

| # | Check | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Launch and hear the welcome | NOT TESTED | Android routed startup speech to the speaker. The phone locked during the final launch before the full welcome could be confirmed. |
| 2 | Automatic foreground listening | PASS | The installed app launched and entered Android speech recognition with automatic listening enabled. |
| 3 | Open the rear camera by voice | PASS | Android recognized “Open camera,” then the phone sent camera frames to FastAPI. |
| 4 | Correct guidance for a receipt moved out of frame | NOT TESTED | Live camera showed corrective and no-document cues. Physical direction and movement still need confirmation. |
| 5 | Center and hold still for readiness | PASS | The phone displayed the “document is properly positioned” cue from live camera samples. The app uses the same cue for speech. |
| 6 | Capture by voice | PASS | Android recognized “Capture” and the live camera photo reached `/ocr`. |
| 7 | Gemini analyzes the captured photo | PASS | Automatic `/analyze` returned HTTP 200 on phone captures. |
| 8 | Automatically speak the description | PASS | The result appeared and Android recorded speech playback after the live analysis. |
| 9 | Follow-up question and spoken answer | PASS | Android recognized natural questions. Two real Gemini answers returned HTTP 200 and triggered Android speech playback. |
| 10 | Scan again by voice | PASS | The native recognizer returned “Scan again,” the rear camera reopened, and new frames reached FastAPI. |
| 11 | Stop listening and navigate with TalkBack | NOT TESTED | The first on-device attempt exposed an alternate-transcript bug. The focused regression passed and the fix was installed. The phone locked before the voice retry, and TalkBack traversal is pending. |
| 12 | Installable Android APK | PASS | Gradle built the signed APK, and ADB installed and opened version 1.2.0 on the SM-M326B. |

TypeScript, voice routing and lifecycle checks, and all seven backend tests passed. Backend checks included signed rotation cues on controlled images, framing metrics, OCR, and live Gemini description and Q&A. The sampled document stayed on the phone and FastAPI until a capture requested Gemini analysis.

## Version 1.3.0

| Check | Automated evidence | Android device evidence |
| --- | --- | --- |
| Left, right, up and down corrections | PASS on portrait fixtures with ordinary, rotated and mirrored EXIF data. | Physical correction and recentering in each direction still pending. |
| Distance, clipping, blur, tilt and no document | PASS on image fixtures. The detector also selected a receipt over a larger, weaker rectangle. | The phone received live alignment responses and displayed **Move farther away**. The other physical cases are pending. |
| Readiness and contradictory frames | PASS. Three agreeing sharp frames are required. Drift, alternating corrections and stale samples reset readiness. | Pending. |
| Portrait preview and capture | PASS for normalized image dimensions and direction tests. The signed APK declares a portrait activity. | Android reported portrait display rotation with the rear camera open. A local-only capture reached FastAPI as a 1080 × 1440 portrait image. |
| Voice selection and sequencing | PASS for preferred voice selection, unavailable voice fallback, phrase boundaries, and microphone-release gating. | Automatic recognition accepted **Open camera**. The phone selected Samsung English voice `en-IN-SMTf00`. Listener confirmation of voice quality is pending. |
| OCR and Gemini | PASS for local OCR, live image description and live Q&A on fixtures. | Actual phone capture reached OCR and displayed a text result. The v1.3 phone-to-Gemini and spoken follow-up run is pending. |
| APK | PASS. Signed arm64 APK built and installed as version 1.3.0 on the SM-M326B. | PASS. |

### Changelog

- `backend/app/alignment.py` and `backend/app/schemas.py` rank quadrilaterals by local edge evidence and report corners, boundary score, and portrait frame dimensions. `backend/app/main.py` records normalized OCR image dimensions.
- `mobile/src/camera/alignmentGuidance.ts`, `frameAnalysis.ts`, and `mobile/src/api/client.ts` handle stable corners, changing corrections, and reminder timing. `mobile/src/voice/voiceCommands.ts` accepts **Repeat guidance** and **Check alignment**.
- `mobile/scripts/configure-camera.cjs`, `mobile/package.json`, `mobile/app.json`, `mobile/src/screens/CameraScreen.tsx`, and `mobile/src/camera/capture.ts` keep the rear preview and captured pixels in the portrait coordinate system. `mobile/App.tsx` speaks a recovery message if capture orientation is invalid.
- `mobile/src/voice/voiceSelection.ts` and `speechOutput.ts` choose an installed English voice and finish the active phrase before starting the next.
- `backend/tests/test_workflow.py` and `mobile/tests/guidance-and-speech.test.cjs` cover the changed behavior. The README describes the build and physical demo.

### Version 1.3.1 framing retry

- Verified the phone could reach FastAPI over USB. The earlier generic warning did not identify which step failed.
- Added separate recovery cues for camera samples, sideways frames, unreadable uploads, connection failures, slow responses, and server errors. The app retries automatically and expires stale measurements.
- Six mobile checks and TypeScript passed. Installed the signed APK on the SM-M326B, observed ten live alignment requests returning HTTP 200, and saw the phone display **Move farther away**.

## v1.3.2 hybrid camera alignment

Use a printed demo receipt with a known total and a plain, non-sensitive background. Run each camera setup twice on the same phone, first with **Use local framing** and then with **Use Gemini framing**. Start from a still phone in portrait and keep the receipt position fixed between runs. Record the first cue, seconds until that cue, repeated and opposite cues, and whether **Capture** produced readable OCR and a spoken Gemini description. For the unavailable case, disable Gemini alignment on the PC or disconnect its internet temporarily while USB stays connected. Restore the enabled setting or the connection before the next run.

| Setup | Expected action or state | Fixture or automated evidence |
|---|---|---|
| Receipt on the left | Move the phone left and verify the receipt shifts toward preview center | OpenCV portrait, rotated EXIF, and mirrored EXIF |
| Receipt on the right | Move the phone right | OpenCV portrait and EXIF |
| Receipt above center | Move the phone up | OpenCV portrait and EXIF |
| Receipt below center | Move the phone down | OpenCV portrait and EXIF |
| Too close | Move farther away | OpenCV area and unclipped flag |
| Too far | Move closer | OpenCV area |
| Partly cut off | Move farther away | OpenCV clipped-edge distance |
| Blurry | Hold still | OpenCV Laplacian measurement |
| Tilted | Rotate the phone until the document lines are upright | OpenCV checks both rotation directions |
| Aligned | Hear the ready cue once, then capture by voice | Mobile verifies three stable observations and cue timing |
| No document | Hear uncertainty and be able to say **Capture anyway** | Blank fixture and a competing pair of contours |
| Gemini unavailable | Continue hearing measured OpenCV corrections | Simulated quota, timeout, and upstream failure, plus real upstream timeouts in fixture runs |

Initial synthetic comparison used 11 ordinary portrait scenes and one difficult low-contrast left scene. OpenCV returned the expected action on the 11 ordinary scenes in 11–35 ms and reported uncertainty on the low-contrast scene. The hybrid path preserved all 11 expected actions. Gemini completed three assessments in 1.5–1.8 seconds and the original 4.3-second timeout triggered on the other nine. The mobile regressions check agreement, expiration, readiness, speech interruption, and whether repeated or contradictory cues are suppressed. Physical motion, repeated cues, and capture success require the paired phone runs above.

With the final 6.5-second backend timeout, 15 backend tests passed, including real Gemini framing, description, and question requests. Eight mobile tests and TypeScript passed. On the left-offset fixture, OpenCV took 15 ms and Gemini took 3.3 seconds. On two additional low-contrast left fixtures, OpenCV reported uncertainty. Live Gemini identified the receipt on the left in 1.9 and 2.1 seconds, and the fusion logic mapped both observations to **Move your phone slightly left**.

The SM-M326B reached both framing endpoints over USB. Live Gemini assessments completed in about 1.7–3.3 seconds while OpenCV continued measuring the frame. The phone took a 1080 × 1440 portrait capture. OCR, Gemini description, and Gemini follow-up each returned HTTP 200. The tester confirmed hearing the description and the answer. The final signed APK was installed and opened as version 1.3.2. The phone displayed **Move farther away. Part of the page is cut off** and OpenCV continued returning that correction through an upstream failure.

In the subsequent phone run on the final APK, Gemini supplied **Move farther away** and **Move your phone slightly left** candidates on frames where OpenCV could not find a boundary. These are backend decisions. The app still requires two matching hints and discards them when newer measured corners arrive.

## v1.3.3 real-time preview alignment

The backend passed 17 tests, including live Gemini framing, description and question calls. The mobile suite passed 10 tests, including diagonal jitter, measured progress, fresh-frame readiness and microphone release. TypeScript passed. The 420 × 560 test fixtures cover all four directions, blur while off center and rejection of small clipped background objects. EXIF tests cover sideways and mirrored JPEGs.

The first APK used Expo's prebuilt Android camera library and fell back to still photos on the phone. The rebuilt, signed APK compiles the patched camera module from source. On the SM-M326B over USB it analyzed 420 × 560 rear-camera preview frames at 3.35–3.78 frames per second. In the first 428 preview frames, median backend processing time was 7.4 ms and the 95th percentile was 9.2 ms. Rolling mean frame age at analysis was 229–296 ms.

On the phone, the app logged spoken clipping, hold-still and readiness cues. A portrait 1080 × 1440 capture reached OCR and the live Gemini description, and Gemini completed a follow-up question. During the direction trials, the document was often near the edge or out of frame. All four physical translations still need confirmation with a smaller document in the preview.

For each physical trial, start with a centered receipt and enough space around it. Translate the phone right, left, down and up in separate trials while keeping its angle and distance fixed. Expect left, right, up and down respectively. Stop with the receipt centered and hold still until the app says **Alignment fixed. Document ready. Say capture.** Repeat while deliberately moving the phone, clipping the document or blurring it to verify readiness is withheld. Finish by saying **Capture**, listening to the Gemini description and asking for the total.

## v1.4 Gemini Live

Use the signed APK with the backend running over USB. Use non-sensitive receipts, printed pages, menus, and notices. Record audible behavior and the backend evidence separately.

| Phone trial | Evidence to capture |
|---|---|
| Launch and say **Open camera** | Privacy notice, automatic foreground listening, and camera opening without a microphone tap |
| Show a receipt, then replace it with a notice or menu | Short native descriptions for the initial scene and the changed scene. Check that holding the same item still does not trigger repeated descriptions |
| Move right, left, down and up from center | Record the cue and elapsed time after each movement. Keep the full document visible and return to center between trials |
| Change distance, clip an edge, blur, then hold still | Observe warnings and readiness. Disturb the frame again and verify correction resumes |
| Speak over an active Live description | Check that audio stops and the new utterance is handled. Record whether the device uses speaker or headphones |
| Say **Capture**, then ask a natural question | Observe a portrait capture, OCR and native explanation, a relevant follow-up question, then a grounded answer and continued listening |
| Say **Scan again**, **Close camera**, and **Stop listening** | The scan reopens by voice, closing stops video, and stopping listening ends the microphone session. Resume from the TalkBack-compatible control |
| Disconnect and reattach the USB cable | OpenCV and AI service errors are clear. The app retries the Live session once the connection returns |

The real WebSocket smoke test on 24 November 2026 opened Gemini 3.8 Live in 0.9 seconds, dispatched **Open camera** from generated PCM, sent synthetic portrait frames for scene narration, and narrated a trusted answer. The protocol regression tests exercise bounded media, aspect validation, command matching, and scene deduplication. The backend logs setup time and command names. Android development logs report frame rate, age and the cue chosen without recording scene text, microphone audio, or transcripts.

On the Samsung SM-M326B, the Android audio module reported echo cancellation on. The foreground Live connection became ready in 1.55 seconds. The phone opened the camera and captured by voice. The tester confirmed hearing the automatic scene narration and capture explanation, and successfully interrupted narration by speaking. The backend processed a portrait 1080 × 1440 capture, ran OCR and Gemini analysis, and answered a spoken follow-up. The phone logged right, down, distance, hold-still and readiness cues. Preview analysis ran at 3.37–3.79 frames per second with rolling mean frame age of 131–333 ms during this run. Frame age measures the video pipeline and does not measure time from a physical movement to playback of a correction.

The tester also confirmed rescanning, a changed scene description, closing the camera and stopping listening. The backend recorded the close and stop-listening commands, and the device offered **Resume listening** afterward.

All 21 backend tests passed with the live Gemini endpoint regressions enabled. All 10 mobile regressions and TypeScript passed. The Live smoke test also verified playable PCM in both narration paths. The tester checked some physical directions. Formal movement-to-cue latency, alignment success rate, the remaining directions and coverage across all document types require further controlled testing.

An upgrade check of 1.4.0 exposed a listening-preference reset. The app was stopped immediately and 1.4.1 moved the preference into Android's private settings. When upgrading without a saved choice in the new store, the app starts with listening off. The signed 1.4.1 APK was installed on the Samsung. The app offered **Resume listening** on the first launch and after a second cold launch, with the USB backend still available.

In 1.4.2, automatic foreground listening defaults to on when no explicit choice is saved. On the Samsung, Live started automatically after the update, **Stop listening** survived a cold relaunch, and Live recovered without another tap after the USB forwarding was interrupted and restored. The phone was left with **Live listening is on**.

## v1.5 one Gemini voice

The signed v1.5.0 build opened on the Samsung with the reduced-control layout. A real Live smoke test returned PCM for the scene, the measured framing phrase, and the document answer. The phone reported echo cancellation and cleared playback after it detected speech during camera narration. A portrait capture reached OCR and Gemini image analysis. The backend regression suite passed 19 tests with 3 opt-in REST API tests skipped. The mobile suite passed 10 tests, and TypeScript passed.

The tester confirmed that framing and the document answer used the same voice and that Gemini stopped when they started speaking.

## v1.6 hosted server pairing

The backend passed 23 tests, with three opt-in REST AI tests skipped. TypeScript and all 12 mobile tests passed. A temporary loopback TLS server accepted a paired image upload and rejected unauthenticated HTTPS and WebSocket requests. The authenticated WSS smoke test streamed generated speech and a synthetic receipt and received live narration for the scene, a framing cue, and a document answer.

The signed 1.6.0 APK was installed on the Samsung. The pairing screen showed the server address and access key fields. Cancelling returned to the USB home screen and preserved the paused listening preference. Hosted pairing and mobile-data testing remain for the deployment step.
