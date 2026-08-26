package app.zynbot.mobile.harvester

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.View
import android.webkit.CookieManager
import android.webkit.HttpAuthHandler
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.ProxyConfig
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.random.Random

class HarvesterEngine(
  context: Context,
  private val callback: Callback,
) {
  interface Callback {
    fun onLog(text: String)
    fun onCapture(headers: Map<String, String>, proxy: String, userAgent: String, pageUrl: String)
    fun onHarvested(count: Int)
  }

  companion object {
    private const val CART_URL = "carts.target.com/web_checkouts/v1/cart_items"
    private const val LOGIN_URL = "gsp.target.com/gsp/authentications/v1/credential_validations"
    private const val SENSOR_HEADER_MATCH = "x-g"
    private const val ATC_SELECTOR = "button[class*=fullWidth][id^=addToCartButtonOrTextIdFor][aria-label^=\"Add to cart\" i]"
    private const val SHIPPING_SELECTOR = "button[data-test='fulfillment-cell-shipping']"
    private const val CONSENT_SELECTOR = "button#VA_HEALTH_CONSENT_BUTTON"
    private const val STICKY_TOP = 60
    private const val VIEWPORT_WIDTH = 1080
    private const val VIEWPORT_HEIGHT = 1920
    private const val ATC_PER_CYCLE = 10
    private const val ATC_CONFIRM_MS = 2500L
    private const val ELEMENT_TIMEOUT_MS = 30_000L
    private const val MIN_ITER_MS = 750L
    private const val NAV_TIMEOUT_MS = 60_000L
    private val LOW_DATA_DOMAINS = listOf("assets.targetimg1.com", "zeronaught.com")
    private val CART_URLS = listOf(CART_URL, LOGIN_URL)
    private val FALLBACK_URLS = listOf(
      "https://www.target.com/p/150ct-craft-sticks-natural-mondo-llama-8482/-/A-81212453#lnk=sametab",
      "https://www.target.com/p/24ct-crayons-classic-colors-mondo-llama-8482/-/A-81212656#lnk=sametab",
      "https://www.target.com/p/4oz-washable-school-glue-up-38-up-8482/-/A-50625017#lnk=sametab",
      "https://www.target.com/p/smudge-free-erasers-up-up/-/A-52673887?preselect=14046184#lnk=sametab",
      "https://www.target.com/p/cap-erasers-25ct-up-38-up-8482/-/A-10805583#lnk=sametab",
    )
    private const val TAG = "ZynHarvest"
  }

  private val appContext = context.applicationContext
  private val main = Handler(Looper.getMainLooper())
  private val random = Random.Default
  private val marker = "harvestB-${System.nanoTime()}"
  @Volatile private var stopped = false
  @Volatile private var web: WebView? = null
  @Volatile private var activeProxy: ProxyEndpoint? = null
  private val captureCount = AtomicInteger()
  private var totalHarvested = 0
  private var localProxy: LocalAuthProxy? = null
  private var cdp: CdpClient? = null
  private var pageLoads = ArrayBlockingQueue<String>(1)

  fun stop() {
    stopped = true
  }

  fun run(proxies: List<String>, @Suppress("UNUSED_PARAMETER") site: String, lowDataRequested: Boolean) {
    val parsed = ArrayList<ProxyEndpoint>()
    for (line in proxies) {
      val endpoint = ProxyEndpoint.parse(line)
      if (endpoint != null) parsed.add(endpoint)
      else if (line.isNotBlank()) log("ignoring unparseable proxy: $line")
    }
    if (parsed.isEmpty()) {
      log("No proxies supplied")
      return
    }
    if (!ProxyManager.isSupported()) {
      log("WebView too old for proxy override")
      return
    }
    var lowData = lowDataRequested
    if (lowData && LOW_DATA_DOMAINS.isEmpty()) {
      log("low-data requested but no scoped hosts known for target -- proxying all traffic this run")
      lowData = false
    } else if (lowData) {
      if (!ProxyManager.isLowDataSupported()) {
        log("WebView too old for low-data (reverse bypass)")
        return
      }
      log("low-data mode: proxying only ${LOW_DATA_DOMAINS.joinToString(", ")}; blocking images")
    }
    log("loaded ${FALLBACK_URLS.size} product URL(s) for target; ${parsed.size} proxy(ies)")
    log("Harvesting — 1 window(s)")
    try {
      createWebView(lowData)
      load("about:blank", 15_000)
      eval("window.__ctlMarker = '$marker'")
      val client = CdpClient.attachToPageWhere("window.__ctlMarker", marker)
      cdp = client
      log("cdp attached to \"${client.attachedTitle}\"")
      enableFetch(client)
      val proxy = LocalAuthProxy { text -> log(text) }
      localProxy = proxy
      proxy.start()
      val localEndpoint = ProxyEndpoint.parse("http://${proxy.hostPort()}")
        ?: throw IllegalStateException("local auth proxy bind failed")
      ProxyManager.setProxy(localEndpoint, if (lowData) LOW_DATA_DOMAINS else null)
      log("local auth proxy on ${proxy.hostPort()}")
      var index = 0
      var urlIndex = 0
      var cycle = 0
      while (!stopped) {
        cycle += 1
        try {
          runCycle(cycle, parsed[index], FALLBACK_URLS[urlIndex])
        } catch (error: InterruptedException) {
          Thread.currentThread().interrupt()
          return
        } catch (error: Exception) {
          log("cycle $cycle failed: $error")
        }
        index = (index + 1) % parsed.size
        urlIndex = (urlIndex + 1) % FALLBACK_URLS.size
      }
    } catch (error: Exception) {
      Log.e(TAG, "harvester run failed", error)
      log("run failed: $error")
    } finally {
      teardown()
      log("Idle")
    }
  }

  private fun enableFetch(client: CdpClient) {
    client.on("Fetch.requestPaused") { params -> onRequestPaused(params) }
    val patterns = JSONArray()
    for (url in CART_URLS) {
      patterns.put(
        JSONObject()
          .put("urlPattern", "${ProxyConfig.MATCH_ALL_SCHEMES}$url${ProxyConfig.MATCH_ALL_SCHEMES}")
          .put("requestStage", "Request"),
      )
    }
    client.send("Fetch.enable", JSONObject().put("patterns", patterns))
    log("Fetch interception enabled for ${CART_URLS.size} URL pattern(s)")
  }

  private fun onRequestPaused(params: JSONObject) {
    val requestId = params.optString("requestId")
    val request = params.optJSONObject("request")
    if (request == null) {
      continueRequest(requestId)
      return
    }
    val url = request.optString("url")
    val method = request.optString("method")
    if (!method.equals("POST", true) || !matchesCartUrl(url)) {
      continueRequest(requestId)
      return
    }
    try {
      val rawHeaders = request.optJSONObject("headers") ?: JSONObject()
      val userAgent = rawHeaders.optString("User-Agent", rawHeaders.optString("user-agent"))
      val headers = LinkedHashMap<String, String>()
      rawHeaders.keys().forEach { key ->
        if (key.lowercase(Locale.US).contains(SENSOR_HEADER_MATCH)) {
          val value = rawHeaders.optString(key)
          if (value.isNotEmpty()) headers[key] = value
        }
      }
      if (headers.isNotEmpty()) {
        val proxy = activeProxy
        callback.onCapture(headers, proxy?.raw.orEmpty(), userAgent, url)
        captureCount.incrementAndGet()
        totalHarvested += 1
        log("captured ${headers.size} shape headers from ${shortUrl(url)}")
      } else {
        log("cart POST had no $SENSOR_HEADER_MATCH* headers: ${shortUrl(url)}")
      }
    } catch (error: Exception) {
      Log.w(TAG, "capture handler threw", error)
    }
    try {
      cdp?.sendAsync("Fetch.failRequest", JSONObject().put("requestId", requestId).put("errorReason", "Aborted"))
    } catch (_: Exception) {}
  }

  private fun matchesCartUrl(url: String): Boolean = CART_URLS.any { url.contains(it) }

  private fun continueRequest(requestId: String) {
    if (requestId.isEmpty()) return
    cdp?.sendAsync("Fetch.continueRequest", JSONObject().put("requestId", requestId))
  }

  private fun runCycle(cycle: Int, proxy: ProxyEndpoint, url: String) {
    localProxy?.setUpstream(proxy)
    activeProxy = proxy
    clearIdentity()
    log("Loading Product")
    log("cycle $cycle upstream=${proxy.hostPort()}${if (proxy.hasCredentials()) " user=${proxy.username}" else " (no auth)"} url=${shortUrl(url)}")
    load(url, NAV_TIMEOUT_MS)
    if (!prepare(url)) {
      log("cycle $cycle prepare failed; rotating")
      return
    }
    var captured = 0
    var stalls = 0
    while (captured < ATC_PER_CYCLE && !stopped) {
      val started = System.currentTimeMillis()
      val before = captureCount.get()
      val candidates = atcCandidateCount()
      val tapped = clickInContentAtc()
      log("Harvesting Cookie")
      if (tapped && waitForCapture(before, ATC_CONFIRM_MS)) {
        captured += 1
        log("Harvested Cookie")
        callback.onHarvested(totalHarvested)
        stalls = 0
      } else {
        stalls += 1
        if (!tapped) {
          log(if (candidates <= 0) "no in-content ATC candidate (stall $stalls)" else "ATC tap blocked (stall $stalls)")
        }
        dismissErrorModal()
        clearBlockingOverlays()
        if (stalls >= 3) {
          log("cycle $cycle stalled after $stalls attempts; rotating")
          break
        }
        log("Loading Product")
        suppressPopup()
        waitForPageSettled()
      }
      rateLimit(started)
    }
    log("cycle $cycle captured $captured/$ATC_PER_CYCLE")
  }

  private fun prepare(url: String): Boolean {
    log("viewport ${eval("String(window.innerWidth)+'x'+String(window.innerHeight)+' dpr='+String(window.devicePixelRatio)")}")
    suppressPopup()
    waitForPageSettled()
    if (eval("!!(document.querySelector('div[data-test=\"productNotFound\"]')||document.querySelector('div[data-test=\"NonbuyableSection\"]'))") == "true") {
      log("out of stock: ${shortUrl(url)}")
      return false
    }
    tryClick(CONSENT_SELECTOR)
    if (tryClick(SHIPPING_SELECTOR)) {
      log("pre-click $SHIPPING_SELECTOR")
      Thread.sleep(MIN_ITER_MS)
      log("after shipping ${clearBlockingOverlays()}")
    }
    clearBlockingOverlays()
    return waitForAtc()
  }

  private fun waitForPageSettled() {
    val deadline = System.currentTimeMillis() + ELEMENT_TIMEOUT_MS
    while (System.currentTimeMillis() < deadline && !stopped) {
      val loading = eval("(function(){var el=document.querySelector('div[role=\"status\"]');if(!el)return false;var h=el.outerHTML;return h.indexOf('Still loading')!==-1||h.indexOf('Almost there')!==-1;})()")
      if (loading != "true") return
      Thread.sleep(250)
    }
  }

  private fun waitForAtc(): Boolean {
    val deadline = System.currentTimeMillis() + ELEMENT_TIMEOUT_MS
    while (System.currentTimeMillis() < deadline && !stopped) {
      if (atcCandidateCount() > 0) return true
      suppressPopup()
      Thread.sleep(250)
    }
    return false
  }

  private fun clickInContentAtc(): Boolean {
    val count = atcCandidateCount()
    if (count <= 0) return false
    val index = random.nextInt(count)
    val rect = parseRect(eval(scrollAtcJs(index))) ?: return false
    if (rect[1] < STICKY_TOP) {
      log("post-scroll top=${rect[1].toInt()} below sticky threshold")
      return false
    }
    val x = rect[0] + random.nextDouble() * (rect[2] - rect[0])
    val y = rect[1] + random.nextDouble() * (rect[3] - rect[1])
    var over = eval(elementAtPointJs(x, y))
    if (over != "ok") {
      log(String.format(Locale.US, "ATC point (%.0f, %.0f) is over %s -- clearing overlay", x, y, over))
      clearBlockingOverlays()
      over = eval(elementAtPointJs(x, y))
      if (over != "ok") {
        log(String.format(Locale.US, "ATC point (%.0f, %.0f) is over %s -- not tapping", x, y, over))
        return false
      }
    }
    log(String.format(Locale.US, "ATC tap %d/%d at (%.0f, %.0f)", index + 1, count, x, y))
    cdp?.tapAt(x, y)
    return true
  }

  private fun waitForCapture(before: Int, timeoutMs: Long): Boolean {
    val deadline = System.currentTimeMillis() + timeoutMs
    while (System.currentTimeMillis() < deadline && !stopped) {
      if (captureCount.get() > before) return true
      Thread.sleep(100)
    }
    return captureCount.get() > before
  }

  private fun dismissErrorModal() {
    repeat(3) {
      if (stopped || eval("!!document.querySelector('div[data-test=errorContent]')") != "true") return
      tryClick("button[data-test=errorContent-okButton],div[data-test=errorContent] > button")
      val deadline = System.currentTimeMillis() + 1500
      while (System.currentTimeMillis() < deadline) {
        if (eval("!!document.querySelector('div[data-test=errorContent]')") != "true") return
        Thread.sleep(100)
      }
    }
  }

  private fun rateLimit(startedAt: Long) {
    val elapsed = System.currentTimeMillis() - startedAt
    if (stopped || elapsed >= MIN_ITER_MS) return
    Thread.sleep(MIN_ITER_MS - elapsed)
  }

  private fun clearBlockingOverlays(): String {
    return eval(
      """
      (function(){
        var n=0;
        var hide=function(el){
          if(!el||!el.style)return;
          el.style.setProperty('pointer-events','none','important');
          el.style.setProperty('display','none','important');
          n++;
        };
        var sels=['[class*="styles_overlay"]','[class*="styles_Overlay"]','.ModalDrawer','[role="dialog"]','[data-test*="overlay"]','[data-test*="Modal"]'];
        for(var s=0;s<sels.length;s++){
          var els=document.querySelectorAll(sels[s]);
          for(var i=0;i<els.length;i++){
            var el=els[i];
            if(el.closest&&el.closest('button[id^="addToCartButtonOrTextIdFor"]')) continue;
            hide(el);
          }
        }
        var closes=document.querySelectorAll('button[aria-label="Close" i],button[aria-label="close"],button[data-test="modal-close"],button[data-test="closeButton"]');
        for(var j=0;j<closes.length;j++){ try{closes[j].click(); n++;}catch(e){} }
        return 'hid:'+n;
      })()
      """.trimIndent(),
    )
  }

  private fun suppressPopup() {
    log(
      "popup stub -> " + eval(
        """
        (function(){
          var closePopups=function(){
            var n=0;
            var ds=document.querySelectorAll('.ModalDrawer');
            for(var i=0;i<ds.length;i++){
              var d=ds[i];
              if(d&&d.style&&d.querySelector&&d.querySelector('[data-test="errorContent"]')){
                if(d.offsetParent)n++;
                d.style.setProperty('display','none','important');
              }
            }
            return n;
          };
          if(!document.getElementById('__zynPopupStyle')){
            try{
              var st=document.createElement('style');
              st.id='__zynPopupStyle';
              st.textContent='.ModalDrawer:has([data-test="errorContent"]){display:none!important}';
              (document.head||document.documentElement).appendChild(st);
            }catch(e){}
            try{(window.__zynObs=new MutationObserver(closePopups)).observe(document.documentElement,{childList:true,subtree:true});}catch(e){}
          }
          return 'hid:'+closePopups();
        })()
        """.trimIndent(),
      ),
    )
  }

  private fun atcCandidateCount(): Int {
    return try { JSONArray(eval(atcCandidatesJs())).length() } catch (_: Exception) { 0 }
  }

  private fun atcCandidatesJs(): String {
    return "(function(){var els=document.querySelectorAll(${JSONObject.quote(ATC_SELECTOR)});var out=[];for(var i=0;i<els.length;i++){var r=els[i].getBoundingClientRect();if(r.top<$STICKY_TOP)continue;if(r.width<=0||r.height<=0)continue;out.push([r.left,r.top,r.right,r.bottom]);}return JSON.stringify(out);})()"
  }

  private fun scrollAtcJs(index: Int): String {
    return "(function(){var els=document.querySelectorAll(${JSONObject.quote(ATC_SELECTOR)});var vis=[];for(var i=0;i<els.length;i++){var b=els[i].getBoundingClientRect();if(b.top>=$STICKY_TOP&&b.width>0&&b.height>0)vis.push(els[i]);}var e=vis[$index];if(!e)return '[]';e.scrollIntoView({block:'center'});var r=e.getBoundingClientRect();return JSON.stringify([r.left,r.top,r.right,r.bottom]);})()"
  }

  private fun elementAtPointJs(x: Double, y: Double): String {
    return "(function(){var e=document.elementFromPoint(${x.toInt()},${y.toInt()});if(!e)return 'nothing';if(e.closest(${JSONObject.quote(ATC_SELECTOR)}))return 'ok';var c=(e.className&&e.className.split)?e.className.split(' ')[0]:'';return e.tagName+(c?'.'+c:'');})()"
  }

  private fun tryClick(selector: String): Boolean {
    if (eval("!!document.querySelector(${JSONObject.quote(selector)})") != "true") return false
    return try {
      cdp?.clickSelector(selector)
      true
    } catch (_: Exception) {
      log("element vanished before click: $selector")
      false
    }
  }

  private fun parseRect(raw: String): DoubleArray? {
    return try {
      val array = JSONArray(raw)
      if (array.length() < 4) null
      else doubleArrayOf(array.getDouble(0), array.getDouble(1), array.getDouble(2), array.getDouble(3))
    } catch (_: Exception) {
      null
    }
  }

  private fun createWebView(lowData: Boolean) {
    runOnMain {
      WebView.setWebContentsDebuggingEnabled(true)
      val view = WebView(appContext)
      @SuppressLint("SetJavaScriptEnabled")
      view.settings.javaScriptEnabled = true
      view.settings.domStorageEnabled = true
      view.settings.databaseEnabled = true
      view.settings.useWideViewPort = true
      view.settings.loadWithOverviewMode = true
      view.settings.mediaPlaybackRequiresUserGesture = false
      view.settings.blockNetworkImage = lowData
      view.settings.loadsImagesAutomatically = !lowData
      view.settings.userAgentString = view.settings.userAgentString.replace("; wv", "")
      CookieManager.getInstance().setAcceptCookie(true)
      CookieManager.getInstance().setAcceptThirdPartyCookies(view, true)
      view.measure(
        View.MeasureSpec.makeMeasureSpec(VIEWPORT_WIDTH, View.MeasureSpec.EXACTLY),
        View.MeasureSpec.makeMeasureSpec(VIEWPORT_HEIGHT, View.MeasureSpec.EXACTLY),
      )
      view.layout(0, 0, VIEWPORT_WIDTH, VIEWPORT_HEIGHT)
      view.webViewClient = object : WebViewClient() {
        override fun onPageFinished(view: WebView?, url: String?) {
          pageLoads.offer(url ?: "")
        }

        override fun onReceivedHttpAuthRequest(view: WebView?, handler: HttpAuthHandler?, host: String?, realm: String?) {
          val proxy = activeProxy
          if (proxy != null && proxy.hasCredentials() && host != null && host.contains(proxy.host)) {
            handler?.proceed(proxy.username, proxy.password ?: "")
          } else {
            handler?.cancel()
          }
        }
      }
      web = view
    }
  }

  private fun load(url: String, timeoutMs: Long) {
    val queue = ArrayBlockingQueue<String>(1)
    pageLoads = queue
    main.post { web?.loadUrl(url) }
    if (queue.poll(timeoutMs, TimeUnit.MILLISECONDS) == null) {
      throw IllegalStateException("timed out loading ${shortUrl(url)}")
    }
  }

  private fun eval(script: String, timeoutMs: Long = 10_000): String {
    val result = ArrayBlockingQueue<String>(1)
    main.post {
      val view = web
      if (view == null) result.offer("null")
      else view.evaluateJavascript(script) { value -> result.offer(value ?: "null") }
    }
    val raw = result.poll(timeoutMs, TimeUnit.MILLISECONDS)
      ?: throw IllegalStateException("timed out evaluating: $script")
    return try { JSONArray("[$raw]").get(0).toString() } catch (_: Exception) { raw }
  }

  private fun clearIdentity() {
    val queue = ArrayBlockingQueue<Boolean>(1)
    main.post {
      WebStorage.getInstance().deleteAllData()
      web?.clearCache(true)
      CookieManager.getInstance().removeAllCookies {
        CookieManager.getInstance().flush()
        queue.offer(true)
      }
    }
    try { queue.poll(5, TimeUnit.SECONDS) } catch (_: InterruptedException) {
      Thread.currentThread().interrupt()
    }
  }

  private fun teardown() {
    try { cdp?.close() } catch (_: Exception) {}
    cdp = null
    ProxyManager.clearProxy()
    activeProxy = null
    try { localProxy?.close() } catch (_: Exception) {}
    localProxy = null
    runOnMain {
      val view = web
      view?.destroy()
      web = null
    }
  }

  private fun log(text: String) {
    Log.i(TAG, text)
    callback.onLog(text)
  }

  private fun shortUrl(url: String): String = if (url.length <= 80) url else url.take(80) + "..."

  private fun runOnMain(block: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) {
      block()
      return
    }
    val queue = ArrayBlockingQueue<Boolean>(1)
    main.post {
      try { block() } finally { queue.offer(true) }
    }
    try { queue.poll(10, TimeUnit.SECONDS) } catch (_: InterruptedException) {
      Thread.currentThread().interrupt()
    }
  }
}
