import { Pressable, StyleSheet, Text } from 'react-native';

type Props = { label: string; hint?: string; onPress: () => void; disabled?: boolean; secondary?: boolean; expanded?: boolean };

export function ActionButton({ label, hint, onPress, disabled = false, secondary = false, expanded }: Props) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityHint={hint}
      accessibilityState={{ disabled, expanded }} disabled={disabled} onPress={onPress}
      style={({ pressed }) => [styles.button, secondary && styles.secondary, pressed && styles.pressed, disabled && styles.disabled]}>
      <Text style={[styles.label, secondary && styles.secondaryLabel]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { minHeight: 60, backgroundColor: '#DDFB79', borderRadius: 20, padding: 14, alignItems: 'center', justifyContent: 'center' },
  secondary: { backgroundColor: '#172326', borderWidth: 1, borderColor: '#667A77' },
  label: { color: '#142008', fontSize: 19, fontWeight: '700', textAlign: 'center' },
  secondaryLabel: { color: '#F2F7F2' },
  pressed: { opacity: 0.75 },
  disabled: { opacity: 0.55 },
});
