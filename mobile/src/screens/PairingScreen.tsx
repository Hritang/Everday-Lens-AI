import { useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput } from 'react-native';
import { pairServer, useUsbServer } from '../api/serverAccess';
import { ActionButton } from './ActionButton';

type Props = {
  address: string;
  canCancel: boolean;
  showUsb: boolean;
  onDone: () => void;
};

export function PairingScreen({ address, canCancel, showUsb, onDone }: Props) {
  const [url, setUrl] = useState(address);
  const [secret, setSecret] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (action: () => Promise<void>) => {
    setBusy(true);
    setMessage('');
    try {
      await action();
      onDone();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not update the server connection.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.title} accessibilityRole="header">Pair with a server</Text>
      <Text style={styles.body}>Enter the HTTPS address and the access key for your Lens AI server.</Text>
      <Text style={styles.body}>Server address</Text>
      <TextInput style={styles.field} accessibilityLabel="Server address" value={url} onChangeText={setUrl}
        editable={!busy} autoCapitalize="none" autoCorrect={false} keyboardType="url" maxLength={512}
        placeholder="https://your-server.example" placeholderTextColor="#B4C3BA" />
      <Text style={styles.body}>Access key</Text>
      <TextInput style={styles.field} accessibilityLabel="Server access key" value={secret} onChangeText={setSecret}
        editable={!busy} autoCapitalize="none" autoCorrect={false} autoComplete="off"
        importantForAutofill="no" secureTextEntry maxLength={128} />
      <ActionButton label={busy ? 'Connecting…' : 'Pair phone'} disabled={busy || !url.trim() || !secret.trim()}
        onPress={() => void submit(() => pairServer(url, secret))} />
      {!!message && <Text style={styles.body} accessibilityLiveRegion="polite">{message}</Text>}
      {showUsb && <ActionButton label="Use USB connection" secondary disabled={busy}
        onPress={() => void submit(useUsbServer)} />}
      {canCancel && <ActionButton label="Cancel" secondary disabled={busy} onPress={onDone} />}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#101918' },
  content: { paddingTop: 54, paddingHorizontal: 20, paddingBottom: 36, gap: 14 },
  title: { color: '#F2F7F2', fontSize: 32, fontWeight: '800' },
  body: { color: '#F2F7F2', fontSize: 18, lineHeight: 25 },
  field: { color: '#F2F7F2', borderColor: '#B4C3BA', borderWidth: 1, borderRadius: 12,
    padding: 14, minHeight: 56, fontSize: 18 },
});
