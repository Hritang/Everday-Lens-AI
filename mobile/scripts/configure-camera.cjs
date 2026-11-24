const { copyFileSync, readFileSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');

// Expo SDK 58 applies sensor rotation to captures even when Android locks the activity to portrait.
const camera = dirname(require.resolve('expo-camera/package.json'));
const native = join(camera, 'android/src/main/java/expo/modules/camera');
const file = join(native, 'ExpoCameraView.kt');

function patch(target) {
  const original = readFileSync(target, 'utf8');
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  let source = original.replace(/\r\n/g, '\n');
  return (before, after) => {
    if (source.includes(after)) return;
    if (source.split(before).length !== 2) {
      throw new Error(`Expo Camera changed upstream. Recheck the preview integration in ${target}.`);
    }
    source = source.replace(before, after);
    writeFileSync(target, source.replace(/\n/g, newline));
  };
}

const replaceOnce = patch(file);
replaceOnce(
  '  private val orientationEventListener by lazy {',
  `  private fun lockedPortraitRotation(): Int? =
    if (appContext.currentActivity?.requestedOrientation == android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT) {
      previewView.display?.rotation ?: Surface.ROTATION_0
    } else {
      null
    }

  private val orientationEventListener by lazy {`,
);
replaceOnce(
  '        val rotation = when (orientation) {',
  '        val rotation = lockedPortraitRotation() ?: when (orientation) {',
);
replaceOnce(
  '    val preview = Preview.Builder()\n      .setResolutionSelector(resolutionSelector)',
  '    val preview = Preview.Builder()\n      .apply { lockedPortraitRotation()?.let { setTargetRotation(it) } }\n      .setResolutionSelector(resolutionSelector)',
);
replaceOnce(
  '    val imageCaptureBuilder = ImageCapture.Builder()\n      .setResolutionSelector(resolutionSelector)',
  '    val imageCaptureBuilder = ImageCapture.Builder()\n      .apply { lockedPortraitRotation()?.let { setTargetRotation(it) } }\n      .setResolutionSelector(resolutionSelector)',
);

replaceOnce(
  '  private var shouldCreateCamera = false',
  `  private var shouldCreateCamera = false
  var documentPreview = false
    set(value) {
      if (field != value) shouldCreateCamera = true
      field = value
    }
  @Volatile private var documentAnalyzer: DocumentPreviewAnalyzer? = null

  fun takeDocumentPreview(cache: File): Map<String, Any>? {
    val analyzer = documentAnalyzer ?: return mapOf("unsupported" to true)
    return analyzer.takeLatest(cache)
  }`,
);
replaceOnce(
  '    imageAnalysisUseCase = if (shouldScanBarcodes) {\n      createImageAnalyzer()\n    } else {\n      null\n    }',
  `    val useDocumentPreview = documentPreview && lensFacing == CameraType.BACK && cameraMode == CameraMode.PICTURE
    documentAnalyzer = if (useDocumentPreview) DocumentPreviewAnalyzer() else null
    imageAnalysisUseCase = if (useDocumentPreview) {
      ImageAnalysis.Builder()
        .apply { lockedPortraitRotation()?.let { setTargetRotation(it) } }
        .setResolutionSelector(
          ResolutionSelector.Builder()
            .setAspectRatioStrategy(androidx.camera.core.resolutionselector.AspectRatioStrategy.RATIO_4_3_FALLBACK_AUTO_STRATEGY)
            .setResolutionStrategy(ResolutionStrategy(Size(640, 480), ResolutionStrategy.FALLBACK_RULE_CLOSEST_LOWER_THEN_HIGHER))
            .build()
        )
        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
        .build()
        .also { analysis ->
          documentAnalyzer?.let { analysis.setAnalyzer(java.util.concurrent.ForkJoinPool.commonPool(), it) }
        }
    } else if (shouldScanBarcodes) {
      createImageAnalyzer()
    } else {
      null
    }`,
);
replaceOnce(
  `    val useCases = UseCaseGroup.Builder().apply {
      addUseCase(preview)`,
  `    fun useCases(includeAnalysis: Boolean) = UseCaseGroup.Builder().apply {
      if (useDocumentPreview) {
        setViewPort(androidx.camera.core.ViewPort.Builder(android.util.Rational(3, 4),
          lockedPortraitRotation() ?: Surface.ROTATION_0).build())
      }
      addUseCase(preview)`,
);
replaceOnce(
  '        imageAnalysisUseCase?.let {\n          addUseCase(it)\n        }',
  '        if (includeAnalysis) imageAnalysisUseCase?.let { addUseCase(it) }',
);
replaceOnce(
  '    camera = cameraProvider.bindToLifecycle(currentActivity, cameraSelector, useCases)',
  `    camera = try {
      cameraProvider.bindToLifecycle(currentActivity, cameraSelector, useCases(true))
    } catch (error: IllegalArgumentException) {
      if (!useDocumentPreview) throw error
      imageAnalysisUseCase?.clearAnalyzer()
      imageAnalysisUseCase = null
      documentAnalyzer = null
      cameraProvider.unbindAll()
      cameraProvider.bindToLifecycle(currentActivity, cameraSelector, useCases(false))
    }`,
);
replaceOnce('  private fun releaseBarcodeAnalyzer() {', '  private fun releaseBarcodeAnalyzer() {\n    documentAnalyzer = null');

const patchModule = patch(join(native, 'CameraViewModule.kt'));
patchModule(
  '      OnViewDidUpdateProps { view ->',
  `      Prop("documentPreview") { view, enabled: Boolean? ->
        view.documentPreview = enabled == true
      }

      AsyncFunction("takeDocumentPreview") { view: ExpoCameraView ->
        view.takeDocumentPreview(cacheDirectory)
      }

      OnViewDidUpdateProps { view ->`,
);
copyFileSync(join(__dirname, 'DocumentPreviewAnalyzer.kt'), join(native, 'DocumentPreviewAnalyzer.kt'));
