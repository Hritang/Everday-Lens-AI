import { StyleSheet, Text, TextInput, View } from 'react-native';
import type { DocumentResult } from '../state/workflow';
import { ActionButton } from './ActionButton';

type Props = {
  document: DocumentResult;
  disabled: boolean;
  question: string;
  setQuestion: (value: string) => void;
  onTyping: (active: boolean) => void;
  read: () => void;
  retryOcr: () => void;
  describe: () => void;
  askByVoice: () => void;
  submitQuestion: () => void;
  canDictate: boolean;
  expanded: boolean;
};

export function ResultScreen({ document, disabled, question, setQuestion, onTyping, read, retryOcr, describe,
  askByVoice, submitQuestion, canDictate, expanded }: Props) {
  const canSend = !!document.uri && !disabled;
  return (
    <View style={styles.panel}>
      <Text style={styles.heading} accessibilityRole="header">Document</Text>
      {document.uri && <Text style={styles.body}>You can ask a question out loud.</Text>}
      {expanded && <>
      <ActionButton label="Read document" disabled={disabled} onPress={read} secondary />
      {document.ocrError && document.uri && <ActionButton label="Retry text recognition" disabled={disabled} onPress={retryOcr} />}
      <Text style={styles.body}>Lens AI may make mistakes. Descriptions and questions send the photo and any extracted text to an online AI service.</Text>
      <ActionButton label="Describe image with Lens AI" disabled={!canSend} onPress={describe} />
      {canDictate && <ActionButton label="Ask question by voice" disabled={!canSend} onPress={askByVoice}
        hint="The question, photo and extracted text are sent to an online AI service." />}
      <TextInput style={styles.field} accessibilityLabel="Type a question about the document" placeholder="Type a question"
        placeholderTextColor="#B7C4D7" editable={canSend} maxLength={500} value={question} onChangeText={setQuestion}
        onFocus={() => onTyping(true)} onBlur={() => onTyping(false)} />
      <ActionButton label="Send question to Lens AI" disabled={!canSend || !question.trim()} onPress={submitQuestion} />
      </>}
      {!document.uri && <Text style={styles.body}>The temporary photo has been deleted. Scan again to ask Lens AI a new question.</Text>}
      {document.description && (
        <View style={styles.section}>
          <Text style={styles.heading} accessibilityRole="header">AI-generated description</Text>
          <Text style={styles.body} selectable>{document.description.description}</Text>
          {document.description.warnings.map(warning => <Text key={warning} style={styles.body}>{warning}</Text>)}
        </View>
      )}
      {document.answer && (
        <View style={styles.section}>
          <Text style={styles.heading} accessibilityRole="header">AI-generated answer</Text>
          <Text style={styles.body}>Question: {document.lastQuestion}</Text>
          <Text style={styles.body} selectable>{document.answer.answer}</Text>
          {document.answer.uncertain && <Text style={styles.body}>Some information may be unclear or missing.</Text>}
          {!!document.answer.supporting_text && <Text style={styles.body} selectable>OCR excerpt: {document.answer.supporting_text}</Text>}
        </View>
      )}
      {(expanded || !document.description) && <View style={styles.section}>
        <Text style={styles.heading} accessibilityRole="header">Extracted text</Text>
        <Text style={styles.body} selectable>{document.ocr?.text || document.ocr?.warnings[0] || document.ocrError || 'No OCR text available.'}</Text>
      </View>}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { gap: 12, padding: 18, borderRadius: 24, backgroundColor: '#1D2B29' },
  section: { gap: 5, paddingVertical: 4 },
  heading: { color: '#FFFFFF', fontSize: 22, fontWeight: 'bold' },
  body: { color: '#D2DFEF', fontSize: 16, lineHeight: 23 },
  field: { color: '#FFFFFF', borderColor: '#A6B9D0', borderWidth: 1, borderRadius: 8, padding: 12, minHeight: 54, fontSize: 17 },
});
