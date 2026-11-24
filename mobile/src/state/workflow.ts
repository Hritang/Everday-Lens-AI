import type { Answer, Description, OcrResult } from '../api/client';

export type DocumentResult = {
  uri: string | null;
  ocr: OcrResult | null;
  ocrError?: string;
  description?: Description;
  answer?: Answer;
  lastQuestion?: string;
};

export type Workflow =
  | { stage: 'home' | 'permission' | 'aligning' | 'capturing' | 'processing' }
  | { stage: 'result'; document: DocumentResult };
