import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore, type ComponentRef } from 'react';
import { AppState, Keyboard, ScrollView, StyleSheet, Text, View } from 'react-native';
import { type CameraView, useCameraPermissions } from 'expo-camera';
import { getAnswer, getDescription, getOcr, ServiceError } from './src/api/client';
import { getServer, restoreServer, subscribeServer } from './src/api/serverAccess';
import { discardPhoto, PortraitCaptureError, takeDocumentPhoto } from './src/camera/capture';
import { useFrameGuidance } from './src/camera/frameAnalysis';
import { ActionButton } from './src/screens/ActionButton';
import { CameraScreen } from './src/screens/CameraScreen';
import { PairingScreen } from './src/screens/PairingScreen';
import { ResultScreen } from './src/screens/ResultScreen';
import type { DocumentResult, Workflow } from './src/state/workflow';
import { useLiveAssistant } from './src/voice/liveAssistant';
import { listeningPreference, useVoiceCommands, type VoiceCommand } from './src/voice/voiceCommands';

const welcome = 'Lens AI sends audio and camera previews to an online AI service while you use them. '
  + 'Say open camera or stop listening.';
const cameraHelp = 'Say capture for online analysis, or say capture text only.';
const visionNotice = 'Small framing previews are sent for online analysis. Say use local framing to turn this off.';
const aiHelp = 'Ask a question about the document, or say read this, shorter explanation, or scan again.';
const photoLifetime = 10 * 60 * 1000;

function serviceMessage(error: unknown, fallback: string) {
  return error instanceof ServiceError ? error.message : fallback;
}

export default function App() {
  const server = useSyncExternalStore(subscribeServer, getServer);
  const [restored, setRestored] = useState(false);
  const [pairing, setPairing] = useState(false);
  useEffect(() => {
    void restoreServer().catch(() => {}).finally(() => setRestored(true));
  }, []);

  if (!restored) return <View style={styles.screen}><Text style={styles.status}>Opening Lens AI…</Text></View>;
  const needsPairing = server.remote && !server.secret;
  if (pairing || needsPairing) return <PairingScreen address={server.remote ? server.url : ''}
    canCancel={!needsPairing} showUsb={server.remote} onDone={() => setPairing(false)} />;
  return <LensApp key={server.url} openPairing={() => setPairing(true)} remote={server.remote} />;
}

function LensApp({ openPairing, remote }: { openPairing: () => void; remote: boolean }) {
  const camera = useRef<CameraView>(null);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const activePhoto = useRef<{ uri: string; expires: number } | null>(null);
  const locked = useRef(false);
  const [permission, requestPermission] = useCameraPermissions();
  const [workflow, setWorkflow] = useState<Workflow>({ stage: 'home' });
  const [status, setStatus] = useState(welcome);
  const [cameraReady, setCameraReady] = useState(false);
  const [visionEnabled, setVisionEnabled] = useState(true);
  const [visionDisclosed, setVisionDisclosed] = useState(false);
  const [foreground, setForeground] = useState(true);
  const [busy, setBusy] = useState(false);
  const [automatic, setAutomatic] = useState(() => listeningPreference());
  const [previewPaused, setPreviewPaused] = useState(false);
  const [typing, setTyping] = useState(false);
  const [question, setQuestion] = useState('');
  const [moreOpen, setMoreOpen] = useState(false);
  const stage = workflow.stage;
  const document = workflow.stage === 'result' ? workflow.document : null;

  const say = (message: string, spokenMessage = message, isCurrent?: () => boolean) => {
    if (isCurrent?.() === false) return false;
    setStatus(message);
    return AppState.currentState === 'active' && live.speak(spokenMessage, 'verbatim', isCurrent);
  };

  const releasePhoto = () => {
    if (activePhoto.current) discardPhoto(activePhoto.current.uri);
    activePhoto.current = null;
  };

  const stopInBackground = useEffectEvent(() => live.halt());
  useEffect(() => {
    const sub = AppState.addEventListener('change', next => {
      setForeground(next === 'active');
      if (next === 'background') stopInBackground();
    });
    return () => {
      sub.remove();
      if (activePhoto.current) discardPhoto(activePhoto.current.uri);
    };
  }, []);

  useEffect(() => {
    if (!document?.uri || activePhoto.current?.uri !== document.uri) return;
    const uri = document.uri;
    const expiry = setTimeout(() => {
      if (activePhoto.current?.uri === uri) {
        discardPhoto(uri);
        activePhoto.current = null;
        setWorkflow(current => current.stage === 'result' && current.document.uri === uri
          ? { stage: 'result', document: { ...current.document, uri: null } }
          : current);
      }
    }, Math.max(0, activePhoto.current.expires - Date.now()));
    return () => clearTimeout(expiry);
  }, [document?.uri]);

  useEffect(() => {
    if (stage === 'result' || stage === 'home') scroll.current?.scrollTo({ y: 0, animated: false });
  }, [stage]);

  const run = async (operation: () => Promise<void>) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    try {
      await voice.pauseForOutput();
      await operation();
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };

  const openCamera = () => run(async () => {
    if (stage === 'aligning') {
      say('The camera is already open.');
      return;
    }
    setWorkflow({ stage: 'permission' });
    setPreviewPaused(false);
    releasePhoto();
    setQuestion('');
    setCameraReady(false);
    setVisionDisclosed(false);
    frames.reset();
    try {
      if (!permission?.granted && !(await requestPermission()).granted) {
        setWorkflow({ stage: 'home' });
        say('Camera access is needed to scan a document. Enable camera permission in Android settings or try again.');
        return;
      }
      setWorkflow({ stage: 'aligning' });
    } catch {
      setWorkflow({ stage: 'home' });
      say('Could not start the camera. Try opening it again.');
    }
  });

  const goHome = () => {
    if (locked.current) return;
    live.cameraOff();
    releasePhoto();
    frames.reset();
    setCameraReady(false);
    setVisionDisclosed(false);
    setQuestion('');
    setWorkflow({ stage: 'home' });
    say('Back at home. Say Open camera to scan a document.');
  };

  const guide = () => {
    if (stage !== 'aligning') {
      say('Open the camera first to get framing guidance.');
    } else {
      say(frames.current()?.message || frames.failure() || 'Checking framing. Hold your phone over the document.');
    }
  };

  const cameraOpened = () => {
    setCameraReady(true);
    const notice = visionEnabled ? ' ' + visionNotice : '';
    say('Camera opened.' + notice);
    setVisionDisclosed(visionEnabled);
  };

  const changeFraming = (useVision: boolean) => {
    setVisionEnabled(useVision);
    setVisionDisclosed(false);
    frames.clearVision();
    if (!useVision) {
      void say('Local framing is on. Framing samples go only to the document service.');
    } else {
      say(visionNotice);
      setVisionDisclosed(!!camera.current);
    }
  };

  const getText = async (result: DocumentResult & { uri: string }): Promise<DocumentResult & { uri: string }> => {
    try {
      const ocr = await getOcr(result.uri);
      return { ...result, ocr, ocrError: undefined };
    } catch (error) {
      return { ...result, ocr: null, ocrError: serviceMessage(error, 'Text recognition failed.') };
    }
  };

  const updateResult = (result: DocumentResult) => {
    setWorkflow({ stage: 'result', document: { ...result, uri: activePhoto.current?.uri === result.uri ? result.uri : null } });
  };

  const speakDescription = (description: NonNullable<DocumentResult['description']>) => {
    setStatus('AI description ready.');
    live.speak(JSON.stringify({ description: description.description, warnings: description.warnings,
      follow_up: 'Ask one short, relevant question about what the user would like to know next.' }), 'grounded');
  };

  const speakOcr = (source: DocumentResult) => {
    const message = source.ocr?.text || source.ocr?.warnings[0] || source.ocrError || 'No readable text found.';
    void say(source.ocr?.text ? 'Reading extracted text.' : message, message);
  };

  const capture = (withAi = true) => run(async () => {
    const cameraView = camera.current;
    if (stage !== 'aligning' || !cameraView || !cameraReady) {
      say('Open the camera and wait for it to be ready before capturing.');
      return;
    }
    const aligned = frames.current()?.ready;
    live.cameraOff();
    setWorkflow({ stage: 'capturing' });
    if (!aligned) say('Framing is uncertain. Capturing anyway.');
    try {
      await frames.waitForCamera();
      const uri = await takeDocumentPhoto(cameraView);
      releasePhoto();
      activePhoto.current = { uri, expires: Date.now() + photoLifetime };
      setWorkflow({ stage: 'processing' });
      setCameraReady(false);
      void say(withAi ? 'Photo captured. Lens AI is analyzing it.' : 'Photo captured. Reading text.');
      const source = await getText({ uri, ocr: null });
      if (!withAi) {
        updateResult(source);
        speakOcr(source);
        return;
      }
      try {
        const description = await getDescription(uri, source.ocr?.text || '', 'describe');
        updateResult({ ...source, description });
        speakDescription(description);
      } catch (error) {
        updateResult(source);
        const detail = serviceMessage(error, 'Lens AI could not complete image analysis.');
        const fallback = source.ocr?.text ? ' Local text is available. Say read this.' : '';
        void say(detail + fallback + ' Say retry to try again.');
      }
    } catch (error) {
      setWorkflow({ stage: 'aligning' });
      say(error instanceof PortraitCaptureError ? error.message : 'Could not capture a photo. Try again.');
    }
  });

  const read = () => {
    if (document?.ocr?.text) speakOcr(document);
    else if (document?.description) speakDescription(document.description);
    else if (document) speakOcr(document);
    else void say('Capture a document to read its text.');
  };

  const requirePhoto = () => {
    if (document?.uri && activePhoto.current?.uri === document.uri && Date.now() < activePhoto.current.expires) {
      return { ...document, uri: document.uri };
    }
    say('Scan a document first to use this action.');
    return null;
  };

  const describe = (mode: 'describe' | 'summary', refresh = false) => run(async () => {
    if (mode === 'describe' && !refresh && document?.description) {
      speakDescription(document.description);
      return;
    }
    const source = requirePhoto();
    if (!source) return;
    say('Sending the photo and extracted text for online analysis.');
    try {
      const description = await getDescription(source.uri, source.ocr?.text || '', mode);
      updateResult({ ...source, description });
      speakDescription(description);
    } catch (error) {
      aiFailure(error);
    }
  });

  const aiFailure = (error: unknown) => {
    const message = serviceMessage(error, 'Lens AI could not complete the request. Try again.');
    say(document?.ocr?.text ? message + ' Say Read document for the extracted text.' : message);
  };

  const ask = (input: string) => run(async () => {
    const source = requirePhoto();
    const trimmed = input.trim().slice(0, 500);
    if (!source || !trimmed) return;
    say('Sending your question and document for online analysis.');
    try {
      const answer = await getAnswer(source.uri, source.ocr?.text || '', trimmed);
      updateResult({ ...source, answer, lastQuestion: trimmed });
      setQuestion('');
      const uncertainty = answer.uncertain ? ' Some information may be unclear or missing.' : '';
      setStatus('AI answer ready.');
      live.speak(JSON.stringify({ answer: answer.answer, uncertainty }), 'grounded');
    } catch (error) {
      setQuestion(trimmed);
      aiFailure(error);
    }
  });

  const askByVoice = () => {
    if (!requirePhoto()) return;
    if (live.status === 'online') void say('Ask a question about the captured document.');
    else void voice.askByVoice();
  };

  const stopListening = () => {
    live.halt();
    listeningPreference(false);
    setAutomatic(false);
    setPreviewPaused(true);
    frames.reset();
    void say('Listening and preview sharing are off. Use the accessible controls to resume.');
  };

  const resumeListening = () => {
    listeningPreference(true);
    setAutomatic(true);
    setPreviewPaused(false);
    voice.resume();
    setStatus(welcome);
  };

  const repeat = () => { void say(live.previous.current || status); };
  const stopSpeaking = () => live.stopOutput();

  const help = () => {
    if (stage === 'result') say(aiHelp + ' You can also say describe this, repeat, go back, or stop listening.');
    else if (stage === 'aligning') say(cameraHelp + ' You can also say guide me, use local framing, use Lens AI framing, or go back.');
    else say('Say open camera, repeat, or stop listening.');
  };

  const runVoiceCommand = (command: VoiceCommand) => {
    switch (command) {
      case 'open':
      case 'rescan': void openCamera(); break;
      case 'retry':
        if (document?.uri) void describe('describe', true);
        else void openCamera();
        break;
      case 'guide': guide(); break;
      case 'look':
        if (stage === 'aligning' && !live.look()) guide();
        else if (stage === 'result') void describe('describe');
        else if (stage !== 'aligning') void say('Say open camera so I can see what is in front of you.');
        break;
      case 'localFraming': changeFraming(false); break;
      case 'geminiFraming': changeFraming(true); break;
      case 'capture': void capture(); break;
      case 'captureText': void capture(false); break;
      case 'read':
        if (stage === 'aligning') void capture(false);
        else read();
        break;
      case 'repeat': repeat(); break;
      case 'stop': stopSpeaking(); break;
      case 'disable': stopListening(); break;
      case 'close': goHome(); break;
      case 'describe': void describe('describe'); break;
      case 'summary': void describe('summary'); break;
      case 'ask': askByVoice(); break;
      case 'slower':
      case 'faster':
        say('Lens AI uses its natural speaking pace.');
        break;
      case 'cancel': say('Command cancelled.'); break;
      case 'help': help(); break;
    }
  };

  const live = useLiveAssistant({
    enabled: foreground && automatic,
    mode: stage === 'aligning' && !busy ? 'camera' : stage === 'result' ? 'result' : stage === 'home' ? 'home' : 'busy',
    video: stage === 'aligning' && !busy && !previewPaused && visionEnabled && visionDisclosed,
    paused: typing,
    beforeStart: () => voice.pauseForOutput(),
    onCommand: runVoiceCommand,
    onQuestion: input => { void ask(input); },
  });
  const voice = useVoiceCommands({
    automatic: automatic && live.status !== 'online' && live.status !== 'connecting',
    ready: foreground && !busy && !typing && (stage !== 'aligning' || cameraReady),
    acceptsQuestions: !!document?.uri,
    onCommand: runVoiceCommand,
    onQuestion: ask,
    onFeedback: say,
    stopSpeaking: async () => { live.stopOutput(); },
    questionCue: async () => { setStatus('Ask your question.'); },
  });
  const voiceActive = voice.phase !== 'idle';
  const frames = useFrameGuidance(
    camera, foreground && stage === 'aligning' && cameraReady && !previewPaused,
    false,
    !voiceActive && !busy,
    () => !locked.current && live.quiet(),
    (message, isCurrent) => say(message, message, isCurrent),
    live.frame,
  );

  const cameraVisible = stage === 'aligning' || stage === 'capturing';
  const canStopListening = automatic;
  const manualDisabled = busy;
  const micStatus = {
    idle: '', preparing: 'Preparing microphone…', starting: 'Starting microphone…',
    listening: 'Listening now.', processing: 'Recognizing speech…', stopping: 'Stopping microphone…',
  }[voice.phase];

  return (
    <View style={styles.screen}>
      <ScrollView ref={scroll} contentContainerStyle={styles.controls} keyboardShouldPersistTaps="handled">
        <Text style={styles.title} accessibilityRole="header">Lens AI</Text>
        <View style={styles.statusCard}>
          <Text style={styles.connection}>{!automatic ? 'Listening paused' : live.status === 'online'
            ? 'Lens AI is listening' : live.status === 'fallback' ? 'Reconnecting to Lens AI'
              : micStatus || 'Connecting to Lens AI'}</Text>
          <Text style={styles.status} accessibilityLiveRegion={live.status === 'online' ? 'none' : 'polite'}>{status}</Text>
        </View>
        {cameraVisible && (
          <>
            <CameraScreen camera={camera} onReady={cameraOpened} onError={() => {
              setCameraReady(false);
              setWorkflow({ stage: 'home' });
              say('The camera could not start. Try opening it again.');
            }} />
            <ActionButton label="Capture photo" onPress={() => void capture()} disabled={manualDisabled || !cameraReady}
              hint="Sends the photo to an online AI service for analysis." />
            <ActionButton label="Close camera" onPress={goHome} disabled={manualDisabled} secondary />
          </>
        )}
        {stage === 'home' && <ActionButton label="Open camera" onPress={() => void openCamera()} disabled={manualDisabled} />}
        {(voice.available || live.available) && <ActionButton label={canStopListening ? 'Stop listening' : 'Resume listening'}
          onPress={canStopListening ? stopListening : resumeListening} secondary />}
        {document && (
          <>
            <ActionButton label="Scan again" onPress={() => void openCamera()} disabled={manualDisabled} />
            <ResultScreen document={document} disabled={manualDisabled} read={read}
              retryOcr={() => void run(async () => {
                const source = requirePhoto();
                if (!source) return;
                const refreshed = await getText(source);
                updateResult(refreshed);
                speakOcr(refreshed);
              })}
              describe={() => void describe('describe')} question={question} setQuestion={setQuestion}
              askByVoice={askByVoice} canDictate={voice.available} expanded={moreOpen}
              submitQuestion={() => { Keyboard.dismiss(); void ask(question); }}
              onTyping={active => {
                setTyping(active);
                if (active) void voice.pauseForOutput();
              }} />
          </>
        )}
        <ActionButton label={moreOpen ? 'Hide more actions' : 'More actions'} onPress={() => setMoreOpen(!moreOpen)}
          secondary expanded={moreOpen} />
        {moreOpen && <View style={styles.more}>
          <ActionButton label="Stop speaking" onPress={stopSpeaking} secondary />
          <ActionButton label="Repeat last message" onPress={repeat} secondary />
          {stage === 'aligning' && <>
            <ActionButton label="Repeat framing guidance" onPress={guide} secondary disabled={manualDisabled} />
            <ActionButton label="Describe live view" onPress={() => runVoiceCommand('look')} secondary disabled={manualDisabled || !cameraReady} />
            <ActionButton label="Capture text only" onPress={() => void capture(false)} secondary disabled={manualDisabled || !cameraReady} />
          </>}
          {(stage === 'home' || stage === 'aligning') && <ActionButton
            label={visionEnabled ? 'Use local framing' : 'Use Lens AI framing'} onPress={() => changeFraming(!visionEnabled)}
            secondary disabled={manualDisabled} />}
          {document && <ActionButton label="Back to home" onPress={goHome} secondary disabled={manualDisabled} />}
          {stage === 'home' && <ActionButton label={remote ? 'Change server pairing' : 'Pair with a server'}
            onPress={openPairing} secondary disabled={manualDisabled} />}
          <ActionButton label="Help" onPress={help} secondary />
          <Text style={styles.note}>An online AI service receives audio while listening is on and previews while online framing is active.</Text>
        </View>}
        {!voice.available && <Text style={styles.note}>Install the native Android build to use voice commands.</Text>}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#101918' },
  title: { color: '#F2F7F2', fontSize: 32, fontWeight: '800' },
  statusCard: { backgroundColor: '#1D2B29', borderRadius: 24, padding: 20, gap: 10 },
  connection: { color: '#DDFB79', fontSize: 17, fontWeight: '700' },
  status: { color: '#F2F7F2', fontSize: 22, lineHeight: 30 },
  controls: { paddingTop: 54, paddingHorizontal: 20, paddingBottom: 36, gap: 14 },
  more: { gap: 12 },
  note: { color: '#C4D4CC', fontSize: 16, lineHeight: 23 },
});
