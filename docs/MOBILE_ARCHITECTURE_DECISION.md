# Android-first decision

The original design dated 21 Nov 2026 specified React/Vite + browser APIs. Due to the 27 November deadline and requirement for a **mobile application**, the client is changed to **Expo React Native**. The FastAPI/OCR/Gemini concepts, scope boundaries, user stories and evaluation protocol remain the basis.

The Android app sends opt-in, low-resolution samples to FastAPI for OpenCV framing guidance. A deliberate capture sends the photo to the project backend for local OCR. The user requests a description or asks a question to send the photo and available OCR to Gemini. Android speech recognition handles commands and the separate question utterance. Text-to-speech reads guidance, OCR, descriptions, and answers.

USB debugging with ADB reverse connects the test phone to the Windows backend without shared Wi-Fi. The local APK permits HTTP to the USB loopback endpoint. Configure an HTTPS backend before distributing the app.
