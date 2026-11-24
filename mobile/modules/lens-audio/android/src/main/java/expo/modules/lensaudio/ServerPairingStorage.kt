package expo.modules.lensaudio

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal class ServerPairingStorage(context: Context) {
  private val preferences = context.getSharedPreferences("lens_server", Context.MODE_PRIVATE)
  private val alias = "lens-server-pairing"

  private fun keyStore() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

  @Synchronized fun load(): Map<String, String>? {
    val url = preferences.getString("url", null) ?: return null
    val iv = preferences.getString("iv", null) ?: return null
    val encrypted = preferences.getString("secret", null) ?: return null
    val key = keyStore().getKey(alias, null) as? SecretKey ?: return null
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)))
    cipher.updateAAD(url.toByteArray(Charsets.UTF_8))
    val secret = cipher.doFinal(Base64.decode(encrypted, Base64.NO_WRAP)).toString(Charsets.UTF_8)
    return mapOf("url" to url, "secret" to secret)
  }

  @Synchronized fun save(url: String, secret: String) {
    val key = (keyStore().getKey(alias, null) as? SecretKey)
      ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
        init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
          .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
          .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
          .setKeySize(256)
          .build())
      }.generateKey()
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, key)
    cipher.updateAAD(url.toByteArray(Charsets.UTF_8))
    val encrypted = cipher.doFinal(secret.toByteArray(Charsets.UTF_8))
    check(preferences.edit().putString("url", url)
      .putString("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
      .putString("secret", Base64.encodeToString(encrypted, Base64.NO_WRAP)).commit())
  }

  @Synchronized fun clear() {
    check(preferences.edit().clear().commit())
  }
}
