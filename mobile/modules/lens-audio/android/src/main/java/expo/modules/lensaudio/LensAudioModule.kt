package expo.modules.lensaudio

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import android.os.Build
import android.util.Base64
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import kotlin.math.sqrt

class LensAudioModule : Module() {
  private class Stream(val manager: AudioManager, val input: AudioRecord, val output: AudioTrack) {
    val playback = ArrayBlockingQueue<ByteArray>(160)
    val lock = Any()
    val priorMode = manager.mode
    @Suppress("DEPRECATION")
    val priorSpeaker = manager.isSpeakerphoneOn
    var focus: AudioFocusRequest? = null
    var echo: AcousticEchoCanceler? = null
    var noise: NoiseSuppressor? = null
    @Volatile var running = true
    @Volatile var muted = false
    @Volatile var revision = 0
    var written = 0L
  }

  @Volatile private var active: Stream? = null
  private val pairingStorage by lazy {
    ServerPairingStorage(checkNotNull(appContext.reactContext).applicationContext)
  }

  override fun definition() = ModuleDefinition {
    Name("LensAudio")
    Events("pcm", "audioError")
    AsyncFunction("loadServerPairing") { pairingStorage.load() }
    AsyncFunction("saveServerPairing") { url: String, secret: String -> pairingStorage.save(url, secret) }
    AsyncFunction("clearServerPairing") { pairingStorage.clear() }

    Function("readListeningPreference") {
      val context = appContext.reactContext ?: return@Function false
      val store = context.getSharedPreferences("lens_privacy", Context.MODE_PRIVATE)
      if (store.contains("listen")) store.getBoolean("listen", false) else null
    }
    Function("saveListeningPreference") { enabled: Boolean ->
      val context = appContext.reactContext ?: return@Function false
      context.getSharedPreferences("lens_privacy", Context.MODE_PRIVATE)
        .edit().putBoolean("listen", enabled).commit()
    }
    AsyncFunction("start") { start() }
    Function("stop") { stop() }
    Function("mute") { muted: Boolean -> active?.muted = muted }
    Function("clear") { active?.let(::clear) }
    Function("play") { encoded: String ->
      val stream = active
      if (stream != null && encoded.length <= 180_000) {
        val pcm = Base64.decode(encoded, Base64.DEFAULT)
        if (pcm.size >= 2 && pcm.size % 2 == 0 && !stream.playback.offer(pcm)) clear(stream)
      }
    }
    Function("playing") {
      val stream = active
      stream != null && synchronized(stream.lock) {
        stream.running && (stream.playback.isNotEmpty() ||
          stream.output.playbackHeadPosition.toLong().and(0xffffffffL) < stream.written)
      }
    }
    OnDestroy { stop() }
  }

  @SuppressLint("MissingPermission")
  @Suppress("DEPRECATION")
  @Synchronized private fun start(): Boolean {
    if (active != null) return active?.echo?.enabled == true
    val context = appContext.reactContext ?: error("Android audio is unavailable")
    val manager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    val input = AudioRecord(MediaRecorder.AudioSource.VOICE_COMMUNICATION,
      16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
      maxOf(5120, AudioRecord.getMinBufferSize(16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)))
    val attributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
      .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
    val output = try {
      AudioTrack.Builder().setAudioAttributes(attributes).setTransferMode(AudioTrack.MODE_STREAM)
        .setAudioFormat(AudioFormat.Builder().setSampleRate(24000).setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
          .setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
        .setBufferSizeInBytes(maxOf(4800, AudioTrack.getMinBufferSize(24000,
          AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT))).build()
    } catch (error: RuntimeException) {
      input.release()
      throw error
    }
    val stream = Stream(manager, input, output)
    active = stream
    try {
      check(input.state == AudioRecord.STATE_INITIALIZED && output.state == AudioTrack.STATE_INITIALIZED)
      if (Build.VERSION.SDK_INT >= 26) {
        stream.focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
          .setAudioAttributes(attributes)
          .setOnAudioFocusChangeListener { change ->
            if (change < 0 && active === stream) {
              stop()
              sendEvent("audioError", emptyMap<String, Any>())
            }
          }.build()
        check(manager.requestAudioFocus(stream.focus!!) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED)
      }
      manager.mode = AudioManager.MODE_IN_COMMUNICATION
      if (manager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).none {
          it.type == android.media.AudioDeviceInfo.TYPE_BLUETOOTH_SCO ||
            it.type == android.media.AudioDeviceInfo.TYPE_WIRED_HEADSET ||
            it.type == android.media.AudioDeviceInfo.TYPE_WIRED_HEADPHONES ||
            it.type == android.media.AudioDeviceInfo.TYPE_USB_HEADSET
        }) manager.isSpeakerphoneOn = true
      stream.echo = if (AcousticEchoCanceler.isAvailable()) AcousticEchoCanceler.create(input.audioSessionId) else null
      stream.noise = if (NoiseSuppressor.isAvailable()) NoiseSuppressor.create(input.audioSessionId) else null
      stream.echo?.enabled = true
      stream.noise?.enabled = true
      input.startRecording()
      check(input.recordingState == AudioRecord.RECORDSTATE_RECORDING)
      thread(name = "LensMic", isDaemon = true) { record(stream) }
      thread(name = "LensSpeaker", isDaemon = true) { play(stream) }
      return stream.echo?.enabled == true
    } catch (error: RuntimeException) {
      stop()
      throw error
    }
  }

  private fun record(stream: Stream) {
    val buffer = ByteArray(1280)
    var voicedFrames = 0
    while (stream.running) {
      val read = try { stream.input.read(buffer, 0, buffer.size) } catch (_: RuntimeException) { -1 }
      if (read < 0) {
        if (active === stream) {
          stop()
          sendEvent("audioError", emptyMap<String, Any>())
        }
        return
      }
      if (!stream.running || stream.muted || read < 2) continue
      val bytes = read and -2
      var energy = 0.0
      for (index in 0 until bytes step 2) {
        val value = (buffer[index].toInt() and 255) or (buffer[index + 1].toInt() shl 8)
        energy += value.toDouble() * value
      }
      val level = sqrt(energy / (bytes / 2))
      val playing = synchronized(stream.lock) {
        stream.running && (stream.playback.isNotEmpty() ||
          stream.output.playbackHeadPosition.toLong().and(0xffffffffL) < stream.written)
      }
      voicedFrames = if (playing && stream.echo?.enabled == true && level >= 650) voicedFrames + 1 else 0
      val interrupted = voicedFrames >= 2
      if (interrupted) {
        clear(stream)
        voicedFrames = 0
      }
      sendEvent("pcm", mapOf("data" to Base64.encodeToString(buffer, 0, bytes, Base64.NO_WRAP),
        "level" to level, "interrupted" to interrupted))
    }
  }

  private fun play(stream: Stream) {
    while (stream.running) {
      val revision = stream.revision
      val pcm = stream.playback.poll(40, TimeUnit.MILLISECONDS) ?: continue
      var offset = 0
      while (offset < pcm.size && stream.running && revision == stream.revision) {
        val written = synchronized(stream.lock) {
          if (!stream.running || revision != stream.revision) return@synchronized -1
          if (stream.output.playState != AudioTrack.PLAYSTATE_PLAYING) stream.output.play()
          stream.output.write(pcm, offset, pcm.size - offset, AudioTrack.WRITE_NON_BLOCKING).also {
            if (it > 0) stream.written += it / 2
          }
        }
        if (written < 0) break
        offset += written
        if (written == 0) Thread.sleep(10)
      }
    }
  }

  private fun clear(stream: Stream) = synchronized(stream.lock) {
    stream.revision++
    stream.playback.clear()
    if (stream.output.state == AudioTrack.STATE_INITIALIZED) {
      if (stream.output.playState == AudioTrack.PLAYSTATE_PLAYING) stream.output.pause()
      stream.output.flush()
    }
    stream.written = 0
  }

  @Suppress("DEPRECATION")
  @Synchronized private fun stop() {
    val stream = active ?: return
    active = null
    stream.running = false
    runCatching { stream.input.stop() }
    stream.input.release()
    stream.echo?.release()
    stream.noise?.release()
    synchronized(stream.lock) {
      clear(stream)
      stream.output.release()
    }
    if (Build.VERSION.SDK_INT >= 26) stream.focus?.let { stream.manager.abandonAudioFocusRequest(it) }
    stream.manager.isSpeakerphoneOn = stream.priorSpeaker
    stream.manager.mode = stream.priorMode
  }
}
