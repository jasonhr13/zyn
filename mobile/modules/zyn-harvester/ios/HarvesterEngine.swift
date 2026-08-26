import Foundation
import UIKit

final class HarvesterEngine {
  struct Callbacks {
    var onLog: (String) -> Void
    var onCapture: (_ headers: [String: String], _ proxy: String, _ userAgent: String, _ pageUrl: String) -> Void
    var onHarvested: (Int) -> Void
  }

  static let maxWindows = 6
  private let callbacks: Callbacks
  private var windows: [HarvestWindow] = []
  private let harvestLock = NSLock()
  private var totalHarvested = 0

  init(callbacks: Callbacks) {
    self.callbacks = callbacks
  }

  func stop() {
    harvestLock.lock()
    let current = windows
    harvestLock.unlock()
    current.forEach { $0.stop() }
    DispatchQueue.main.async {
      HarvestHost.hide()
      UIApplication.shared.isIdleTimerDisabled = false
    }
  }

  func run(proxies: [String], site: String, lowData: Bool, workers: Int) {
    DispatchQueue.main.async { UIApplication.shared.isIdleTimerDisabled = true }
    defer { DispatchQueue.main.async { UIApplication.shared.isIdleTimerDisabled = false } }
    var parsed: [ProxyEndpoint] = []
    for line in proxies {
      if let endpoint = ProxyEndpoint.parse(line) {
        parsed.append(endpoint)
      } else if !line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        callbacks.onLog("ignoring unparseable proxy: \(line)")
      }
    }
    if parsed.isEmpty {
      callbacks.onLog("No proxies supplied")
      return
    }
    let count = max(1, min(Self.maxWindows, workers, parsed.count))
    callbacks.onLog("Harvesting — \(count) window(s)")
    HarvestWebKit.warm(lowData: lowData)
    let group = DispatchGroup()
    var started: [HarvestWindow] = []
    for index in 0..<count {
      let shard = parsed.enumerated().compactMap { $0.offset % count == index ? $0.element : nil }
      let lines = shard.isEmpty ? parsed : shard
      let window = HarvestWindow(
        index: index,
        total: count,
        proxies: lines,
        lowData: lowData,
        callbacks: HarvestWindow.Callbacks(
          onLog: { [weak self] text in self?.callbacks.onLog(text) },
          onCapture: { [weak self] headers, proxy, ua, url in
            self?.callbacks.onCapture(headers, proxy, ua, url)
          },
          onHarvested: { [weak self] _ in
            guard let self else { return }
            self.harvestLock.lock()
            self.totalHarvested += 1
            let total = self.totalHarvested
            self.harvestLock.unlock()
            self.callbacks.onHarvested(total)
          }
        )
      )
      started.append(window)
      harvestLock.lock()
      windows = started
      harvestLock.unlock()
      group.enter()
      DispatchQueue.global(qos: .userInitiated).async {
        if index > 0 { Thread.sleep(forTimeInterval: Double(index) * 0.12) }
        window.run()
        group.leave()
      }
    }
    group.wait()
    harvestLock.lock()
    windows = []
    harvestLock.unlock()
    DispatchQueue.main.async { UIApplication.shared.isIdleTimerDisabled = false }
    callbacks.onLog("Idle")
  }
}
