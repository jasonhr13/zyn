import Foundation
import Darwin

struct ProxyEndpoint {
  let host: String
  let port: Int
  let username: String?
  let password: String?
  let raw: String

  var hasCredentials: Bool { !(username ?? "").isEmpty }
  var hostPort: String { "\(host):\(port)" }
  var credential: String {
    guard hasCredentials else { return "" }
    return "\(username ?? ""):\(password ?? "")"
  }

  static func parse(_ raw: String?) -> ProxyEndpoint? {
    guard var trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else { return nil }
    if !trimmed.contains("://") && !trimmed.contains("@") {
      let parts = trimmed.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
      if parts.count >= 4, let port = Int(parts[1]) {
        let pass = parts[3...].joined(separator: ":")
        return ProxyEndpoint(host: parts[0], port: port, username: parts[2], password: pass, raw: trimmed)
      }
    }
    if !trimmed.contains("://") { trimmed = "http://\(trimmed)" }
    guard let url = URL(string: trimmed), let host = url.host, let port = url.port, port > 0 else { return nil }
    var user = url.user
    var pass = url.password
    if let rawUser = user { user = rawUser.removingPercentEncoding ?? rawUser }
    if let rawPass = pass { pass = rawPass.removingPercentEncoding ?? rawPass }
    return ProxyEndpoint(host: host, port: port, username: user, password: pass, raw: raw!.trimmingCharacters(in: .whitespacesAndNewlines))
  }
}

final class LocalAuthProxy {
  private let queue = DispatchQueue(label: "zyn.local-proxy", attributes: .concurrent)
  private var listenFD: Int32 = -1
  private var liveFDs: [Int32] = []
  private var running = false
  private let lock = NSLock()
  private var upstream: ProxyEndpoint?
  private var lowData = false
  private(set) var port: Int = 0

  private let shapeHosts = ["assets.targetimg1.com", "zeronaught.com"]
  private let connectUA =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"

  func setUpstream(_ value: ProxyEndpoint?) {
    lock.lock()
    upstream = value
    lock.unlock()
  }

  func setLowData(_ value: Bool) {
    lock.lock()
    lowData = value
    lock.unlock()
  }

  func start() throws {
    listenFD = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP)
    guard listenFD >= 0 else { throw NSError(domain: "LocalAuthProxy", code: 1) }
    var yes: Int32 = 1
    setsockopt(listenFD, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
    var addr = sockaddr_in()
    addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = 0
    addr.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
    let bindResult = withUnsafePointer(to: &addr) { ptr in
      ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
        Darwin.bind(listenFD, sa, socklen_t(MemoryLayout<sockaddr_in>.size))
      }
    }
    guard bindResult == 0, listen(listenFD, 128) == 0 else { throw NSError(domain: "LocalAuthProxy", code: 2) }
    var got = sockaddr_in()
    var len = socklen_t(MemoryLayout<sockaddr_in>.size)
    let nameResult = withUnsafeMutablePointer(to: &got) { ptr in
      ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
        getsockname(listenFD, sa, &len)
      }
    }
    guard nameResult == 0 else { throw NSError(domain: "LocalAuthProxy", code: 3) }
    port = Int(UInt16(bigEndian: got.sin_port))
    running = true
    queue.async { [weak self] in self?.acceptLoop() }
  }

  func close() {
    lock.lock()
    running = false
    let listen = listenFD
    listenFD = -1
    let live = liveFDs
    liveFDs = []
    lock.unlock()
    if listen >= 0 {
      Darwin.shutdown(listen, SHUT_RDWR)
      Darwin.close(listen)
    }
    for fd in live {
      Darwin.shutdown(fd, SHUT_RDWR)
    }
  }

  private func track(_ fd: Int32) {
    guard fd >= 0 else { return }
    lock.lock()
    liveFDs.append(fd)
    lock.unlock()
  }

  private func untrack(_ fd: Int32) {
    lock.lock()
    liveFDs.removeAll { $0 == fd }
    lock.unlock()
  }

  private func acceptLoop() {
    while running {
      var addr = sockaddr_in()
      var len = socklen_t(MemoryLayout<sockaddr_in>.size)
      let client = withUnsafeMutablePointer(to: &addr) { ptr in
        ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
          accept(listenFD, sa, &len)
        }
      }
      if client < 0 {
        if !running { break }
        continue
      }
      track(client)
      queue.async { [weak self] in self?.handle(client) }
    }
  }

  private func handle(_ client: Int32) {
    defer {
      untrack(client)
      Darwin.shutdown(client, SHUT_RDWR)
      Darwin.close(client)
    }
    var nodelay: Int32 = 1
    setsockopt(client, IPPROTO_TCP, TCP_NODELAY, &nodelay, socklen_t(MemoryLayout<Int32>.size))
    guard let header = readHeaderBlock(client), !header.isEmpty else { return }
    let text = String(bytes: header, encoding: .isoLatin1) ?? ""
    let first = text.components(separatedBy: "\r\n").first ?? ""
    let parts = first.split(separator: " ").map(String.init)
    guard parts.count >= 2 else { return }
    lock.lock()
    let endpoint = upstream
    let low = lowData
    lock.unlock()
    if parts[0].uppercased() == "CONNECT" {
      let target = parts[1]
      let targetHost = target.split(separator: ":").first.map(String.init) ?? target
      if low && !isShapeHost(targetHost) {
        tunnelDirect(client: client, target: target)
        return
      }
      guard let endpoint else {
        _ = writeString(client, "HTTP/1.1 502 No upstream proxy\r\n\r\n")
        return
      }
      tunnelViaProxy(client: client, target: target, endpoint: endpoint)
    } else {
      guard let endpoint else {
        _ = writeString(client, "HTTP/1.1 502 No upstream proxy\r\n\r\n")
        return
      }
      tunnelHttp(client: client, header: text, leftover: [], endpoint: endpoint)
    }
  }

  private func isShapeHost(_ host: String) -> Bool {
    let lower = host.lowercased()
    return shapeHosts.contains { lower == $0 || lower.hasSuffix(".\($0)") }
  }

  private func tunnelViaProxy(client: Int32, target: String, endpoint: ProxyEndpoint) {
    guard let remote = connectTCP(endpoint.host, endpoint.port) else { return }
    track(remote)
    defer { untrack(remote); Darwin.shutdown(remote, SHUT_RDWR); Darwin.close(remote) }
    var connect = "CONNECT \(target) HTTP/1.1\r\nHost: \(target)\r\nUser-Agent: \(connectUA)\r\n"
    if endpoint.hasCredentials {
      let token = Data(endpoint.credential.utf8).base64EncodedString()
      connect += "Proxy-Authorization: Basic \(token)\r\n"
    }
    connect += "Proxy-Connection: keep-alive\r\n\r\n"
    guard writeString(remote, connect), let reply = readHeaderBlock(remote) else { return }
    _ = writeData(client, reply)
    let status = String(bytes: reply, encoding: .isoLatin1) ?? ""
    if status.hasPrefix("HTTP/1.1 200") || status.hasPrefix("HTTP/1.0 200") {
      pump(client, remote)
    }
  }

  private func tunnelDirect(client: Int32, target: String) {
    let bits = target.split(separator: ":")
    let host = bits.first.map(String.init) ?? target
    let port = bits.count > 1 ? Int(bits[1]) ?? 443 : 443
    guard let remote = connectTCP(host, port) else {
      _ = writeString(client, "HTTP/1.1 502 Direct connect failed\r\n\r\n")
      return
    }
    track(remote)
    defer { untrack(remote); Darwin.shutdown(remote, SHUT_RDWR); Darwin.close(remote) }
    _ = writeString(client, "HTTP/1.1 200 Connection Established\r\n\r\n")
    pump(client, remote)
  }

  private func tunnelHttp(client: Int32, header: String, leftover: [UInt8], endpoint: ProxyEndpoint) {
    guard let remote = connectTCP(endpoint.host, endpoint.port) else { return }
    track(remote)
    defer { untrack(remote); Darwin.shutdown(remote, SHUT_RDWR); Darwin.close(remote) }
    var injected = header
    if endpoint.hasCredentials {
      let token = Data(endpoint.credential.utf8).base64EncodedString()
      let auth = "Proxy-Authorization: Basic \(token)\r\n"
      if let range = injected.range(of: "\r\n") {
        injected.insert(contentsOf: auth, at: range.upperBound)
      }
    }
    _ = writeString(remote, injected)
    if !leftover.isEmpty { _ = writeData(remote, Data(leftover)) }
    pump(client, remote)
  }

  private func pump(_ a: Int32, _ b: Int32) {
    let group = DispatchGroup()
    group.enter()
    queue.async {
      self.copy(from: a, to: b)
      group.leave()
    }
    copy(from: b, to: a)
    if group.wait(timeout: .now() + 2) == .timedOut {
      Darwin.shutdown(a, SHUT_RDWR)
      Darwin.shutdown(b, SHUT_RDWR)
      _ = group.wait(timeout: .now() + 1)
    }
  }

  private func copy(from: Int32, to: Int32) {
    var buffer = [UInt8](repeating: 0, count: 16 * 1024)
    while running {
      let n = read(from, &buffer, buffer.count)
      if n <= 0 { break }
      var written = 0
      while written < n {
        let w = buffer.withUnsafeBytes { raw -> Int in
          let ptr = raw.bindMemory(to: UInt8.self).baseAddress!
          return write(to, ptr + written, n - written)
        }
        if w <= 0 { Darwin.shutdown(from, SHUT_RDWR); Darwin.shutdown(to, SHUT_RDWR); return }
        written += w
      }
    }
    Darwin.shutdown(from, SHUT_RD)
    Darwin.shutdown(to, SHUT_WR)
  }

  private func connectTCP(_ host: String, _ port: Int) -> Int32? {
    var hints = addrinfo()
    hints.ai_socktype = SOCK_STREAM
    hints.ai_family = AF_UNSPEC
    var info: UnsafeMutablePointer<addrinfo>?
    let portStr = String(port)
    guard getaddrinfo(host, portStr, &hints, &info) == 0, let first = info else { return nil }
    defer { freeaddrinfo(info) }
    var cursor: UnsafeMutablePointer<addrinfo>? = first
    while let current = cursor {
      let fd = socket(current.pointee.ai_family, current.pointee.ai_socktype, current.pointee.ai_protocol)
      if fd >= 0 {
        var nodelay: Int32 = 1
        setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &nodelay, socklen_t(MemoryLayout<Int32>.size))
        var timeout = timeval(tv_sec: 15, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        if Darwin.connect(fd, current.pointee.ai_addr, current.pointee.ai_addrlen) == 0 {
          return fd
        }
        Darwin.close(fd)
      }
      cursor = current.pointee.ai_next
    }
    return nil
  }

  private func readHeaderBlock(_ fd: Int32) -> Data? {
    var data = Data()
    var byte: UInt8 = 0
    var state = 0
    while data.count < 32_768 {
      let n = read(fd, &byte, 1)
      if n <= 0 { break }
      data.append(byte)
      if (state == 0 || state == 2) && byte == 13 { state += 1 }
      else if (state == 1 || state == 3) && byte == 10 {
        if state == 3 { break }
        state += 1
      } else {
        state = 0
      }
    }
    return data
  }

  @discardableResult
  private func writeString(_ fd: Int32, _ text: String) -> Bool {
    writeData(fd, Data(text.utf8))
  }

  @discardableResult
  private func writeData(_ fd: Int32, _ data: Data) -> Bool {
    data.withUnsafeBytes { raw in
      var written = 0
      let ptr = raw.bindMemory(to: UInt8.self).baseAddress!
      while written < data.count {
        let n = write(fd, ptr + written, data.count - written)
        if n <= 0 { return false }
        written += n
      }
      return true
    }
  }
}
