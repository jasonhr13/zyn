package app.zynbot.mobile.harvester

import android.net.LocalSocket
import android.net.LocalSocketAddress
import android.os.Process
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.nio.charset.StandardCharsets
import java.security.SecureRandom
import java.util.Locale
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class CdpClient private constructor(private val socket: LocalSocket) : AutoCloseable {
  fun interface EventListener { fun onEvent(params: JSONObject) }

  private val input = socket.inputStream
  private val output = socket.outputStream
  private val nextId = AtomicInteger()
  private val random = SecureRandom()
  private val pending = ConcurrentHashMap<Int, ArrayBlockingQueue<Any>>()
  private val listeners = ConcurrentHashMap<String, CopyOnWriteArrayList<EventListener>>()
  private val dispatch = Executors.newSingleThreadExecutor()
  @Volatile private var closed = false
  private var reader: Thread? = null
  var attachedTitle: String = ""
    private set

  fun on(method: String, listener: EventListener) {
    listeners.getOrPut(method) { CopyOnWriteArrayList() }.add(listener)
  }

  fun send(method: String, params: JSONObject? = null, timeoutMs: Long = 30_000): JSONObject {
    val id = nextId.incrementAndGet()
    val queue = ArrayBlockingQueue<Any>(1)
    pending[id] = queue
    writeCommand(id, method, params)
    val reply = queue.poll(timeoutMs, TimeUnit.MILLISECONDS)
      ?: run {
        pending.remove(id)
        throw IOException("timed out waiting for $method")
      }
    if (reply === DEAD) throw IOException("CDP connection closed during $method")
    val json = reply as JSONObject
    if (json.has("error")) throw IOException("$method failed: ${json.opt("error")}")
    return json.optJSONObject("result") ?: JSONObject()
  }

  fun sendAsync(method: String, params: JSONObject? = null) {
    try { writeCommand(nextId.incrementAndGet(), method, params) } catch (_: Exception) {}
  }

  fun eval(expression: String): String {
    val params = JSONObject()
      .put("expression", expression)
      .put("returnByValue", true)
      .put("awaitPromise", true)
    val result = send("Runtime.evaluate", params).optJSONObject("result") ?: JSONObject()
    if (result.has("value")) return result.get("value").toString()
    return result.optString("description", result.optString("type"))
  }

  fun tapAt(x: Double, y: Double) {
    dispatchTouch("touchStart", x, y)
    Thread.sleep(40L + (Math.random() * 60).toLong())
    dispatchTouch("touchEnd", x, y)
  }

  fun clickSelector(selector: String) {
    val raw = eval(
      "(function(){var e=document.querySelector(${JSONObject.quote(selector)});if(!e)return '';e.scrollIntoView({block:'center'});var r=e.getBoundingClientRect();return JSON.stringify([r.left+r.width/2,r.top+r.height/2]);})()",
    )
    if (raw.isEmpty() || raw == "null") throw IOException("element not found: $selector")
    val point = JSONArray(raw)
    tapAt(point.getDouble(0), point.getDouble(1))
  }

  private fun dispatchTouch(type: String, x: Double, y: Double) {
    val points = JSONArray()
    if (type != "touchEnd") {
      points.put(JSONObject().put("x", x).put("y", y))
    }
    send("Input.dispatchTouchEvent", JSONObject().put("type", type).put("touchPoints", points))
  }

  override fun close() {
    closed = true
    try { socket.close() } catch (_: Exception) {}
    dispatch.shutdownNow()
    reader?.interrupt()
    failPending()
  }

  private fun startReader() {
    val thread = Thread({
      while (!closed) {
        try {
          val frame = JSONObject(readTextFrame())
          if (frame.has("id")) {
            pending.remove(frame.optInt("id"))?.offer(frame)
          } else if (frame.has("method")) {
            val method = frame.optString("method")
            val params = frame.optJSONObject("params") ?: JSONObject()
            listeners[method]?.forEach { listener ->
              dispatch.execute {
                try { listener.onEvent(params) } catch (_: Exception) {}
              }
            }
          }
        } catch (_: Exception) {
          closed = true
          failPending()
          return@Thread
        }
      }
    }, "cdp-reader")
    thread.isDaemon = true
    reader = thread
    thread.start()
  }

  private fun failPending() {
    pending.keys.toList().forEach { pending.remove(it)?.offer(DEAD) }
  }

  private fun writeCommand(id: Int, method: String, params: JSONObject?) {
    val body = JSONObject()
      .put("id", id)
      .put("method", method)
      .put("params", params ?: JSONObject())
    writeTextFrame(body.toString())
  }

  @Synchronized
  private fun writeTextFrame(text: String) {
    val payload = text.toByteArray(StandardCharsets.UTF_8)
    val out = ByteArrayOutputStream()
    out.write(129)
    when {
      payload.size < 126 -> out.write(payload.size or 128)
      payload.size < 65536 -> {
        out.write(254)
        out.write((payload.size shr 8) and 255)
        out.write(payload.size and 255)
      }
      else -> {
        out.write(255)
        for (shift in 56 downTo 0 step 8) out.write(((payload.size.toLong() shr shift) and 255).toInt())
      }
    }
    val mask = ByteArray(4)
    random.nextBytes(mask)
    out.write(mask)
    for (i in payload.indices) out.write((payload[i].toInt() and 0xFF) xor (mask[i % 4].toInt() and 0xFF))
    output.write(out.toByteArray())
    output.flush()
  }

  private fun readTextFrame(): String {
    val assembled = ByteArrayOutputStream()
    while (true) {
      val first = readByte()
      val fin = first and 128 != 0
      val opcode = first and 15
      var length = (readByte() and 127).toLong()
      if (length == 126L) length = ((readByte() shl 8) or readByte()).toLong()
      else if (length == 127L) {
        length = 0
        repeat(8) { length = (length shl 8) or readByte().toLong() }
      }
      val size = length.toInt()
      val payload = ByteArray(size)
      var offset = 0
      while (offset < size) {
        val read = input.read(payload, offset, size - offset)
        if (read < 0) throw IOException("socket closed mid-frame")
        offset += read
      }
      when (opcode) {
        8 -> throw IOException("devtools closed the connection")
        9 -> writePong(payload)
        10 -> {}
        else -> {
          assembled.write(payload)
          if (fin) return assembled.toString("UTF-8")
        }
      }
    }
  }

  @Synchronized
  private fun writePong(payload: ByteArray) {
    val mask = ByteArray(4)
    random.nextBytes(mask)
    val out = ByteArrayOutputStream()
    out.write(138)
    out.write(payload.size or 128)
    out.write(mask)
    for (i in payload.indices) out.write((payload[i].toInt() and 0xFF) xor (mask[i % 4].toInt() and 0xFF))
    output.write(out.toByteArray())
    output.flush()
  }

  private fun readByte(): Int {
    val value = input.read()
    if (value < 0) throw IOException("socket closed")
    return value
  }

  private fun handshake(path: String) {
    val key = ByteArray(16)
    random.nextBytes(key)
    val request = "GET $path HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${Base64.encodeToString(key, Base64.NO_WRAP)}\r\nSec-WebSocket-Version: 13\r\n\r\n"
    output.write(request.toByteArray(StandardCharsets.UTF_8))
    output.flush()
    val headers = StringBuilder()
    while (!headers.endsWith("\r\n\r\n")) {
      val next = input.read()
      if (next < 0) throw IOException("socket closed during handshake: $headers")
      headers.append(next.toChar())
    }
    if (!headers.startsWith("HTTP/1.1 101")) throw IOException("websocket upgrade refused: $headers")
  }

  companion object {
    private val DEAD = Any()

    fun attachToPageWhere(expression: String, expected: String): CdpClient {
      val pages = listPageTargets()
      if (pages.isEmpty()) throw IOException("no page target on ${socketName()}")
      for (page in pages) {
        val client = attach(page)
        val matched = try { client.eval(expression) == expected } catch (_: Exception) { false }
        if (matched) return client
        client.close()
      }
      throw IOException("no page target where $expression == $expected (${pages.size} candidates)")
    }

    private fun socketName() = "webview_devtools_remote_${Process.myPid()}"

    private fun open(): LocalSocket {
      val socket = LocalSocket()
      socket.connect(LocalSocketAddress(socketName(), LocalSocketAddress.Namespace.ABSTRACT))
      return socket
    }

    private fun listPageTargets(): List<JSONObject> {
      val body = httpGet("/json/list")
      val pages = ArrayList<JSONObject>()
      val array = JSONArray(body)
      for (index in 0 until array.length()) {
        val item = array.getJSONObject(index)
        if (item.optString("type") == "page") pages.add(item)
      }
      return pages
    }

    private fun attach(target: JSONObject): CdpClient {
      val wsUrl = target.getString("webSocketDebuggerUrl")
      val path = wsUrl.substring(wsUrl.indexOf("/devtools/"))
      val client = CdpClient(open())
      client.handshake(path)
      client.attachedTitle = target.optString("title")
      client.startReader()
      return client
    }

    private fun httpGet(path: String): String {
      open().use { socket ->
        val request = "GET $path HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"
        socket.outputStream.write(request.toByteArray(StandardCharsets.UTF_8))
        socket.outputStream.flush()
        val input = socket.inputStream
        val headerBuf = StringBuilder()
        while (!headerBuf.endsWith("\r\n\r\n")) {
          val next = input.read()
          if (next < 0) throw IOException("socket closed reading headers: $headerBuf")
          headerBuf.append(next.toChar())
        }
        var length = -1
        for (line in headerBuf.split("\r\n")) {
          if (line.lowercase(Locale.US).startsWith("content-length:")) {
            length = line.substringAfter(':').trim().toInt()
            break
          }
        }
        val body = ByteArrayOutputStream()
        val buffer = ByteArray(4096)
        if (length < 0) {
          while (true) {
            val read = input.read(buffer)
            if (read <= 0) break
            body.write(buffer, 0, read)
          }
        } else {
          var got = 0
          while (got < length) {
            val read = input.read(buffer, 0, minOf(buffer.size, length - got))
            if (read < 0) throw IOException("socket closed mid-body")
            body.write(buffer, 0, read)
            got += read
          }
        }
        return body.toString("UTF-8").trim()
      }
    }
  }
}
