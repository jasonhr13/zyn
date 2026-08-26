package app.zynbot.mobile.harvester

import android.net.Uri
import java.util.Locale

class ProxyEndpoint(
  val host: String,
  val port: Int,
  val username: String?,
  val password: String?,
  val scheme: String,
  val raw: String,
) {
  fun hasCredentials(): Boolean = !username.isNullOrEmpty()

  fun hostPort(): String = "$host:$port"

  fun credential(): String {
    if (!hasCredentials()) return ""
    return "$username:${password ?: ""}"
  }

  companion object {
    fun parse(raw: String?): ProxyEndpoint? {
      if (raw == null) return null
      val trimmed = raw.trim()
      if (trimmed.isEmpty()) return null
      if (!trimmed.contains("://") && !trimmed.contains("@")) {
        val parts = trimmed.split(':')
        if (parts.size >= 4) {
          val port = parts[1].toIntOrNull() ?: return null
          return ProxyEndpoint(
            parts[0],
            port,
            parts[2],
            parts.subList(3, parts.size).joinToString(":"),
            "http",
            trimmed,
          )
        }
      }
      var value = trimmed
      if (!value.contains("://")) value = "http://$value"
      val uri = Uri.parse(value)
      val host = uri.host ?: return null
      val port = uri.port
      if (port < 0) return null
      val scheme = (uri.scheme ?: "http").lowercase(Locale.US)
      val userInfo = uri.userInfo
      val username: String?
      val password: String?
      if (userInfo.isNullOrEmpty()) {
        username = null
        password = null
      } else {
        val split = userInfo.indexOf(':')
        if (split >= 0) {
          username = Uri.decode(userInfo.substring(0, split))
          password = Uri.decode(userInfo.substring(split + 1))
        } else {
          username = Uri.decode(userInfo)
          password = ""
        }
      }
      return ProxyEndpoint(host, port, username, password, scheme, trimmed)
    }
  }
}
