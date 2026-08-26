import ExpoModulesCore
import UIKit

public class ZynHarvesterModule: Module {
  private var engine: HarvesterEngine?
  private let workQueue = DispatchQueue(label: "zyn.harvester.engine")
  private var backgroundObserver: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("ZynHarvester")

    Events("onLog", "onSensors", "onHarvested")

    OnCreate {
      self.backgroundObserver = NotificationCenter.default.addObserver(
        forName: UIApplication.didEnterBackgroundNotification,
        object: nil,
        queue: .main
      ) { _ in
        HarvestHost.hide()
      }
    }

    Constants([
      "maxWindows": HarvesterEngine.maxWindows,
    ])

    Function("start") { (proxies: [String], site: String, lowData: Bool, workers: Double) in
      self.engine?.stop()
      let engine = HarvesterEngine(callbacks: HarvesterEngine.Callbacks(
        onLog: { [weak self] text in
          self?.sendEvent("onLog", ["text": text])
        },
        onCapture: { [weak self] headers, proxy, userAgent, pageUrl in
          let headersJson: String
          if let data = try? JSONSerialization.data(withJSONObject: headers),
             let text = String(data: data, encoding: .utf8) {
            headersJson = text
          } else {
            headersJson = "{}"
          }
          self?.sendEvent("onSensors", [
            "headersJson": headersJson,
            "headers": headers,
            "proxy": proxy,
            "userAgent": userAgent,
            "pageUrl": pageUrl,
            "site": "target",
          ])
        },
        onHarvested: { [weak self] count in
          self?.sendEvent("onHarvested", ["count": count])
        }
      ))
      self.engine = engine
      let count = Int(workers)
      self.workQueue.async {
        engine.run(proxies: proxies, site: site, lowData: lowData, workers: count)
        DispatchQueue.main.async {
          if self.engine === engine { self.engine = nil }
        }
      }
    }

    Function("stop") {
      self.halt()
    }

    Function("getItem") { (key: String) -> String? in
      UserDefaults.standard.string(forKey: "zyn.mobile.\(key)")
    }

    Function("setItem") { (key: String, value: String) in
      let storageKey = "zyn.mobile.\(key)"
      if value.isEmpty {
        UserDefaults.standard.removeObject(forKey: storageKey)
      } else {
        UserDefaults.standard.set(value, forKey: storageKey)
      }
    }
  }

  private func halt() {
    let engine = self.engine
    self.engine = nil
    engine?.stop()
  }
}
