package app.zynbot.mobile.harvester

import android.util.Base64
import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.io.InputStream
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.charset.StandardCharsets
import java.util.Collections
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicReference

class LocalAuthProxy(private val logger: ((String) -> Unit)? = null) {
  private val pool = Executors.newCachedThreadPool()
  private val upstream = AtomicReference<ProxyEndpoint?>(null)
  private val active = Collections.synchronizedSet(HashSet<Socket>())
  private val server = ServerSocket().apply { bind(InetSocketAddress("127.0.0.1", 0), 128) }
  @Volatile private var running = true

  fun hostPort(): String = "127.0.0.1:${server.localPort}"

  fun setUpstream(value: ProxyEndpoint?) {
    val previous = upstream.get()
    upstream.set(value)
    if (previous == null || value == null || previous.raw == value.raw) return
    synchronized(active) {
      active.toList().forEach { closeQuietly(it) }
      active.clear()
    }
  }

  fun start() {
    pool.execute {
      while (running) {
        try {
          val client = server.accept()
          pool.execute { handle(client) }
        } catch (error: Exception) {
          if (running) log("accept failed: ${error.message}")
        }
      }
    }
  }

  fun close() {
    running = false
    closeQuietly(server)
    synchronized(active) {
      active.toList().forEach { closeQuietly(it) }
      active.clear()
    }
    pool.shutdownNow()
  }

  private fun handle(client: Socket) {
    active.add(client)
    var remote: Socket? = null
    try {
      client.tcpNoDelay = true
      val block = readHeaderBlock(client.getInputStream())
      if (block.isEmpty()) return
      val header = String(block, StandardCharsets.ISO_8859_1)
      val firstLine = header.substringBefore("\r\n").split(" ")
      if (firstLine.size < 2) return
      val endpoint = upstream.get() ?: run {
        writeStatus(client, "502 No upstream proxy")
        return
      }
      val next = Socket()
      remote = next
      next.connect(InetSocketAddress(endpoint.host, endpoint.port), 15_000)
      next.tcpNoDelay = true
      val toUpstream = next.getOutputStream()
      val fromUpstream = next.getInputStream()
      if (firstLine[0].equals("CONNECT", ignoreCase = true)) {
        val target = firstLine[1]
        val connect = buildString {
          append("CONNECT ").append(target).append(" HTTP/1.1\r\n")
          append("Host: ").append(target).append("\r\n")
          append("User-Agent: ").append(CONNECT_UA).append("\r\n")
          if (endpoint.hasCredentials()) {
            append("Proxy-Authorization: Basic ").append(endpoint.basic()).append("\r\n")
          }
          append("Proxy-Connection: keep-alive\r\n\r\n")
        }
        toUpstream.write(connect.toByteArray(StandardCharsets.ISO_8859_1))
        toUpstream.flush()
        val reply = readHeaderBlock(fromUpstream)
        client.getOutputStream().write(reply)
        client.getOutputStream().flush()
        val status = String(reply, StandardCharsets.ISO_8859_1)
        if (status.startsWith("HTTP/1.1 200") || status.startsWith("HTTP/1.0 200")) {
          pump(client, next)
        } else {
          log("upstream refused CONNECT $target: ${status.substringBefore("\r\n")}")
        }
      } else {
        toUpstream.write(injectAuth(header, endpoint).toByteArray(StandardCharsets.ISO_8859_1))
        toUpstream.flush()
        pump(client, next)
      }
    } catch (error: Exception) {
      log("tunnel error: ${error.message}")
    } finally {
      closeQuietly(remote)
      closeQuietly(client)
      active.remove(client)
    }
  }

  private fun pump(left: Socket, right: Socket) {
    pool.execute { copy(left, right) }
    copy(right, left)
  }

  private fun copy(from: Socket, to: Socket) {
    val buffer = ByteArray(16 * 1024)
    try {
      val input = from.getInputStream()
      val output = to.getOutputStream()
      while (true) {
        val read = input.read(buffer)
        if (read <= 0) break
        output.write(buffer, 0, read)
        output.flush()
      }
    } catch (_: Exception) {
    } finally {
      closeQuietly(from)
      closeQuietly(to)
    }
  }

  private fun injectAuth(header: String, endpoint: ProxyEndpoint): String {
    if (!endpoint.hasCredentials()) return header
    val auth = "Proxy-Authorization: Basic ${endpoint.basic()}\r\n"
    val split = header.indexOf("\r\n")
    return if (split >= 0) header.substring(0, split + 2) + auth + header.substring(split + 2) else header
  }

  private fun readHeaderBlock(input: InputStream): ByteArray {
    val out = ByteArrayOutputStream()
    var state = 0
    while (out.size() < 32_768) {
      val next = input.read()
      if (next < 0) break
      out.write(next)
      state = when {
        (state == 0 || state == 2) && next == '\r'.code -> state + 1
        (state == 1 || state == 3) && next == '\n'.code -> if (state == 3) break else state + 1
        else -> 0
      }
    }
    return out.toByteArray()
  }

  private fun writeStatus(socket: Socket, status: String) {
    try {
      socket.getOutputStream().write("HTTP/1.1 $status\r\n\r\n".toByteArray(StandardCharsets.ISO_8859_1))
      socket.getOutputStream().flush()
    } catch (_: Exception) {}
  }

  private fun closeQuietly(closeable: Closeable?) {
    try { closeable?.close() } catch (_: Exception) {}
  }

  private fun log(text: String) {
    logger?.invoke("[local-proxy] $text")
  }

  companion object {
    private const val CONNECT_UA =
      "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36"
  }
}

private fun ProxyEndpoint.basic(): String =
  Base64.encodeToString(credential().toByteArray(StandardCharsets.UTF_8), Base64.NO_WRAP)
