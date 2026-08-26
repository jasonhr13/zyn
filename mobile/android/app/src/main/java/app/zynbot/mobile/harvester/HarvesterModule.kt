package app.zynbot.mobile.harvester

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.util.concurrent.Executors

class HarvesterModule(private val reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
  private val worker = Executors.newSingleThreadExecutor()
  @Volatile private var engine: HarvesterEngine? = null

  override fun getName() = "ZynHarvester"

  override fun getConstants(): MutableMap<String, Any> = hashMapOf("maxWindows" to 1)

  private fun emit(name: String, payload: com.facebook.react.bridge.WritableMap) {
    if (!reactContext.hasActiveReactInstance()) return
    reactContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit(name, payload)
  }

  private fun emitLog(text: String) {
    if (text.isEmpty()) return
    val log = Arguments.createMap()
    log.putString("text", text)
    emit("onLog", log)
  }

  private fun callback() = object : HarvesterEngine.Callback {
    override fun onLog(text: String) = emitLog(text)

    override fun onCapture(headers: Map<String, String>, proxy: String, userAgent: String, pageUrl: String) {
      val map = Arguments.createMap()
      val headerMap = Arguments.createMap()
      for ((key, value) in headers) headerMap.putString(key, value)
      map.putMap("headers", headerMap)
      map.putString("proxy", proxy)
      map.putString("userAgent", userAgent)
      map.putString("pageUrl", pageUrl)
      map.putString("site", "target")
      emit("onSensors", map)
    }

    override fun onHarvested(count: Int) {
      val map = Arguments.createMap()
      map.putInt("count", count)
      emit("onHarvested", map)
    }
  }

  @ReactMethod
  fun addListener(@Suppress("UNUSED_PARAMETER") eventName: String) {}

  @ReactMethod
  fun removeListeners(@Suppress("UNUSED_PARAMETER") count: Double) {}

  @ReactMethod
  fun start(proxies: ReadableArray?, site: String?, lowData: Boolean, @Suppress("UNUSED_PARAMETER") workers: Double) {
    if (engine != null) return
    val lines = ArrayList<String>()
    if (proxies != null) {
      for (index in 0 until proxies.size()) {
        val line = proxies.getString(index)?.trim().orEmpty()
        if (line.isNotEmpty()) lines.add(line)
      }
    }
    val next = HarvesterEngine(reactContext, callback())
    engine = next
    worker.execute {
      try {
        next.run(lines, site ?: "target", lowData)
      } finally {
        engine = null
      }
    }
  }

  @ReactMethod
  fun stop() {
    engine?.stop()
  }

  @ReactMethod(isBlockingSynchronousMethod = true)
  fun getItem(key: String): String? {
    return reactContext.getSharedPreferences("zyn.mobile", android.content.Context.MODE_PRIVATE)
      .getString(key, null)
  }

  @ReactMethod(isBlockingSynchronousMethod = true)
  fun setItem(key: String, value: String?) {
    val prefs = reactContext.getSharedPreferences("zyn.mobile", android.content.Context.MODE_PRIVATE).edit()
    if (value.isNullOrEmpty()) prefs.remove(key) else prefs.putString(key, value)
    prefs.apply()
  }
}
