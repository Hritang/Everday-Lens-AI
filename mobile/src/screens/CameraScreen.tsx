import { CameraView } from 'expo-camera';
import type { RefObject } from 'react';
import { Platform, StyleSheet, View } from 'react-native';

type Props = {
  camera: RefObject<CameraView | null>;
  onReady: () => void;
  onError: () => void;
};

export function CameraScreen({ camera, onReady, onError }: Props) {
  const previewAnalysis = Platform.OS === 'android' ? { documentPreview: true } : {};
  return (
    <View style={styles.preview} importantForAccessibility="no-hide-descendants">
      <CameraView {...previewAnalysis} ref={camera} style={styles.camera} facing="back" ratio="4:3"
        mirror={false} animateShutter={false} onCameraReady={onReady} onMountError={onError} />
    </View>
  );
}

const styles = StyleSheet.create({
  preview: { width: '100%', aspectRatio: 3 / 4, backgroundColor: '#000', borderRadius: 24, overflow: 'hidden' },
  camera: { flex: 1 },
});
