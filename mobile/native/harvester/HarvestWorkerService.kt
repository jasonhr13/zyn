package app.zynbot.mobile.harvester

import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.os.Message
import android.os.Messenger
import java.io.File

open class HarvestWorkerService : Service() {
  @Volatile private var engine: HarvesterEngine? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      engine?.stop()
      stopSelf()
      return START_NOT_STICKY
    }
    val messenger = messengerFrom(intent)
    val index = intent?.getIntExtra(EXTRA_INDEX, 0) ?: 0
    val total = (intent?.getIntExtra(EXTRA_TOTAL, 1) ?: 1).coerceIn(1, HarvestProcesses.MAX_WORKERS)
    val site = intent?.getStringExtra(EXTRA_SITE) ?: "target"
    val lowData = intent?.getBooleanExtra(EXTRA_LOW_DATA, true) ?: true
    val lines = readLines(intent?.getStringExtra(EXTRA_PROXIES_FILE).orEmpty())
    val shard = HarvestProcesses.shard(lines, index, total)
    val next = HarvesterEngine(applicationContext, object : HarvesterEngine.Callback {
      override fun onLog(text: String) {
        send(messenger, MSG_LOG, "w${index + 1}: $text")
      }

      override fun onCapture(headers: Map<String, String>, proxy: String, userAgent: String, pageUrl: String) {
        val extras = Bundle()
        val headerBundle = Bundle()
        for ((key, value) in headers) headerBundle.putString(key, value)
        extras.putBundle("headers", headerBundle)
        extras.putString("proxy", proxy)
        extras.putString("userAgent", userAgent)
        extras.putString("pageUrl", pageUrl)
        send(messenger, MSG_CAPTURE, extras)
      }

      override fun onHarvested(count: Int) {
        val extras = Bundle()
        extras.putInt("count", count)
        extras.putInt("worker", index + 1)
        send(messenger, MSG_HARVESTED, extras)
      }
    })
    engine = next
    Thread({
      try {
        send(messenger, MSG_LOG, "w${index + 1}: started with ${shard.size} proxy(ies)")
        next.run(shard, site, lowData)
      } finally {
        send(messenger, MSG_DONE, "w${index + 1}: stopped")
        stopSelf()
      }
    }, "zyn-harvest-$index").start()
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    engine?.stop()
    super.onDestroy()
  }

  private fun readLines(path: String): List<String> {
    if (path.isEmpty()) return emptyList()
    return try {
      File(path).readLines().map { it.trim() }.filter { it.isNotEmpty() }
    } catch (_: Exception) {
      emptyList()
    }
  }

  private fun messengerFrom(intent: Intent?): Messenger? {
    if (intent == null) return null
    return if (Build.VERSION.SDK_INT >= 33) {
      intent.getParcelableExtra(EXTRA_CALLBACK, Messenger::class.java)
    } else {
      @Suppress("DEPRECATION")
      intent.getParcelableExtra(EXTRA_CALLBACK)
    }
  }

  private fun send(messenger: Messenger?, what: Int, text: String) {
    val extras = Bundle()
    extras.putString("text", text)
    send(messenger, what, extras)
  }

  private fun send(messenger: Messenger?, what: Int, extras: Bundle) {
    if (messenger == null) return
    try {
      val message = Message.obtain(null, what)
      message.data = extras
      messenger.send(message)
    } catch (_: Exception) {}
  }

  companion object {
    const val ACTION_STOP = "app.zynbot.mobile.harvester.STOP"
    const val EXTRA_CALLBACK = "callback"
    const val EXTRA_PROXIES_FILE = "proxiesFile"
    const val EXTRA_SITE = "site"
    const val EXTRA_LOW_DATA = "lowData"
    const val EXTRA_INDEX = "index"
    const val EXTRA_TOTAL = "total"
    const val MSG_LOG = 1
    const val MSG_CAPTURE = 2
    const val MSG_HARVESTED = 3
    const val MSG_DONE = 4
  }
}

class HarvestWorkerService0 : HarvestWorkerService()
class HarvestWorkerService1 : HarvestWorkerService()
class HarvestWorkerService2 : HarvestWorkerService()
class HarvestWorkerService3 : HarvestWorkerService()
class HarvestWorkerService4 : HarvestWorkerService()
class HarvestWorkerService5 : HarvestWorkerService()
