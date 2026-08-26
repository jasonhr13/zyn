package app.zynbot.mobile.harvester

import android.util.Log
import androidx.webkit.ProxyConfig
import androidx.webkit.ProxyController
import androidx.webkit.WebViewFeature
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.TimeUnit

object ProxyManager {
  private const val APPLY_TIMEOUT_MS = 10_000L
  private const val TAG = "ZynHarvest"
  private val DIRECT = Executor { it.run() }

  fun isSupported(): Boolean = WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)

  fun isLowDataSupported(): Boolean =
    WebViewFeature.isFeatureSupported("PROXY_OVERRIDE_REVERSE_BYPASS")

  fun setProxy(endpoint: ProxyEndpoint, matchDomains: List<String>?) {
    if (!isSupported()) throw IllegalStateException("WebView proxy override not supported on this WebView version")
    val lowData = !matchDomains.isNullOrEmpty()
    if (lowData && !isLowDataSupported()) {
      throw IllegalStateException("low-data mode needs PROXY_OVERRIDE_REVERSE_BYPASS, unavailable on this WebView -- refusing to proxy everything")
    }
    val builder = ProxyConfig.Builder().addProxyRule(endpoint.hostPort())
    if (lowData) {
      for (domain in matchDomains) {
        if (domain.isEmpty()) continue
        builder.addBypassRule(domain)
        builder.addBypassRule("*.$domain")
      }
      builder.setReverseBypassEnabled(true)
    }
    applyBlocking(builder.build())
    val mode = if (lowData) " (low-data: ${matchDomains.joinToString(",")})" else " (all traffic)"
    Log.i(TAG, "[proxy] active -> ${endpoint.hostPort()}$mode")
  }

  fun clearProxy() {
    if (!isSupported()) return
    try {
      val latch = CountDownLatch(1)
      ProxyController.getInstance().clearProxyOverride(DIRECT) { latch.countDown() }
      latch.await(APPLY_TIMEOUT_MS, TimeUnit.MILLISECONDS)
      Log.i(TAG, "[proxy] cleared -> direct")
    } catch (_: InterruptedException) {
      Thread.currentThread().interrupt()
    }
  }

  private fun applyBlocking(config: ProxyConfig) {
    val latch = CountDownLatch(1)
    ProxyController.getInstance().setProxyOverride(config, DIRECT) { latch.countDown() }
    if (!latch.await(APPLY_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
      throw IllegalStateException("timed out applying proxy override")
    }
  }
}
