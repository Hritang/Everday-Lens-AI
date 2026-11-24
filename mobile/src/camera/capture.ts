import type { CameraView } from 'expo-camera';
import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat, type ImageManipulatorContext, type ImageRef } from 'expo-image-manipulator';

export class PortraitCaptureError extends Error {}

type PreviewSample = { uri: string; ageMs: number } | { unsupported: true } | null;

export async function takePreviewSample(camera: CameraView): Promise<PreviewSample> {
  // This method is provided by the Android Expo Camera postinstall integration.
  const native = camera._cameraRef.current as { takeDocumentPreview?: () => Promise<PreviewSample> } | null;
  return native?.takeDocumentPreview ? native.takeDocumentPreview() : { unsupported: true };
}

export function discardPhoto(uri: string) {
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // Android also evicts cache files. A missing cache file is already discarded.
  }
}

export async function takeDocumentPhoto(camera: CameraView, sample = false) {
  // The native camera decodes the JPEG's orientation into the reference's pixels.
  const photo = await camera.takePictureAsync({ pictureRef: true, skipProcessing: false, shutterSound: !sample });

  let context: ImageManipulatorContext | undefined;
  let image: ImageRef | undefined;
  try {
    const maxSide = sample ? 580 : 2200;
    if (photo.width >= photo.height) {
      throw new PortraitCaptureError('Hold your phone upright in portrait and try again.');
    }
    context = ImageManipulator.manipulate(photo);
    if (Math.max(photo.width, photo.height) > maxSide) {
      context.resize(photo.width > photo.height ? { width: maxSide } : { height: maxSide });
    }
    image = await context.renderAsync();
    return (await image.saveAsync({ format: SaveFormat.JPEG, compress: sample ? 0.55 : 0.9 })).uri;
  } finally {
    image?.release();
    context?.release();
    photo.release();
  }
}
