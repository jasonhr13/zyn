import Foundation
import Network
import UIKit
import WebKit

enum HarvestHost {
  private static let lock = NSLock()
  private static var overlay: UIWindow?
  static let tileSize: CGFloat = 48

  static func attach(_ view: UIView, index: Int, total: Int) {
    let work = {
      lock.lock()
      defer { lock.unlock() }
      guard let window = ensureOverlay() else { return }
      if index == 0 { stripOldViews(in: window) }
      let size = tileSize
      view.frame = CGRect(x: CGFloat(index) * size, y: 2, width: size, height: size)
      view.clipsToBounds = true
      view.isUserInteractionEnabled = false
      view.alpha = 1
      window.addSubview(view)
      window.alpha = 0.12
      window.isHidden = false
    }
    if Thread.isMainThread {
      work()
      return
    }
    let waiter = DispatchSemaphore(value: 0)
    DispatchQueue.main.async {
      work()
      waiter.signal()
    }
    _ = waiter.wait(timeout: .now() + 1)
  }

  static func hide() {
    DispatchQueue.main.async {
      overlay?.isHidden = true
      overlay?.alpha = 0
      UIApplication.shared.isIdleTimerDisabled = false
    }
  }

  private static func stripOldViews(in window: UIWindow) {
    for view in window.subviews {
      if let wk = deepestWebView(view) {
        wk.navigationDelegate = nil
        wk.configuration.userContentController.removeScriptMessageHandler(forName: "zynHarvest")
      }
      view.removeFromSuperview()
    }
  }

  private static func deepestWebView(_ view: UIView) -> WKWebView? {
    if let webView = view as? WKWebView { return webView }
    return view.subviews.lazy.compactMap { deepestWebView($0) }.first
  }

  private static func ensureOverlay() -> UIWindow? {
    if let overlay { return overlay }
    let scene = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .first(where: { $0.activationState == .foregroundActive })
      ?? UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
    guard let scene else { return nil }
    let bounds = scene.coordinateSpace.bounds
    let height = tileSize + 4
    let extra = UIWindow(windowScene: scene)
    extra.frame = CGRect(x: 0, y: bounds.height - height, width: bounds.width, height: height)
    extra.windowLevel = UIWindow.Level(rawValue: UIWindow.Level.normal.rawValue + 1)
    extra.backgroundColor = .clear
    extra.isUserInteractionEnabled = false
    extra.isHidden = false
    overlay = extra
    return extra
  }
}

enum HarvestWebKit {
  static let processPool = WKProcessPool()
  private static let lock = NSLock()
  private static var warmed = false
  private static var lowDataRules: WKContentRuleList?

  static func warm(lowData: Bool) {
    lock.lock()
    defer { lock.unlock() }
    let needRules = lowData && lowDataRules == nil
    if warmed && !needRules { return }
    let waiter = DispatchSemaphore(value: 0)
    var list: WKContentRuleList?
    let work = {
      _ = WKWebView(frame: .zero)
      guard needRules else { waiter.signal(); return }
      let rules = #"[{"trigger":{"url-filter":".*","resource-type":["image","media","font"]},"action":{"type":"block"}}]"#
      WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "zyn-low-data", encodedContentRuleList: rules) { compiled, _ in
        list = compiled
        waiter.signal()
      }
    }
    if Thread.isMainThread {
      work()
      if needRules {
        let deadline = Date().addingTimeInterval(8)
        while waiter.wait(timeout: .now() + 0.05) != .success && Date() < deadline {
          RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
        }
      }
    } else {
      DispatchQueue.main.async(execute: work)
      _ = waiter.wait(timeout: .now() + 8)
    }
    warmed = true
    if needRules { lowDataRules = list }
  }

  static func rulesIfLowData(_ lowData: Bool) -> WKContentRuleList? {
    lowData ? lowDataRules : nil
  }
}

final class HarvestWindow: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
  struct Callbacks {
    var onLog: (String) -> Void
    var onCapture: (_ headers: [String: String], _ proxy: String, _ userAgent: String, _ pageUrl: String) -> Void
    var onHarvested: (Int) -> Void
  }

  private let index: Int
  private let total: Int
  private let proxies: [ProxyEndpoint]
  private let lowData: Bool
  private let callbacks: Callbacks
  private let proxy = LocalAuthProxy()
  private var webView: WKWebView?
  private var hostView: UIView?
  private let navLock = NSLock()
  private var navWaiter: DispatchSemaphore?
  private let captureLock = NSLock()
  private var captureCount = 0
  private var totalHarvested = 0
  private var activeProxy = ""
  private var pageUrl = ""
  private var userAgent = ""
  private var currentTcin = AtcPlusTemplate.defaultTcin
  private var originReady = false
  private var plusInjected = false
  @Volatile var stopped = false

  private let atcSelector = "button[class*=fullWidth][id^=addToCartButtonOrTextIdFor][aria-label^=\"Add to cart\" i]"
  private let shippingSelector = "button[data-test='fulfillment-cell-shipping']"
  private let consentSelector = "button#VA_HEALTH_CONSENT_BUTTON"
  private let stickyTop = 60
  private let atcPerCycle = 10
  private let captureWait = 1.6
  private let minIter = 0.45
  private let productUrls = [
    "https://www.target.com/p/150ct-craft-sticks-natural-mondo-llama-8482/-/A-81212453#lnk=sametab",
    "https://www.target.com/p/24ct-crayons-classic-colors-mondo-llama-8482/-/A-81212656#lnk=sametab",
    "https://www.target.com/p/4oz-washable-school-glue-up-38-up-8482/-/A-50625017#lnk=sametab",
    "https://www.target.com/p/smudge-free-erasers-up-up/-/A-52673887?preselect=14046184#lnk=sametab",
    "https://www.target.com/p/cap-erasers-25ct-up-38-up-8482/-/A-10805583#lnk=sametab",
  ]

  init(index: Int, total: Int, proxies: [ProxyEndpoint], lowData: Bool, callbacks: Callbacks) {
    self.index = index
    self.total = max(1, total)
    self.proxies = proxies
    self.lowData = lowData
    self.callbacks = callbacks
  }

  func stop() {
    stopped = true
    navLock.lock()
    navWaiter?.signal()
    navWaiter = nil
    navLock.unlock()
    DispatchQueue.global(qos: .utility).async {
      self.proxy.close()
    }
  }

  func run() {
    if proxies.isEmpty {
      log("No proxies supplied")
      return
    }
    do { try proxy.start() } catch {
      log("proxy start failed: \(error.localizedDescription)")
      return
    }
    proxy.setLowData(lowData)
    createWebView()
    originReady = false
    plusInjected = false
    let ua = eval("navigator.userAgent")
    if ua != "null" && !ua.isEmpty { userAgent = ua }
    log("w\(index + 1): local auth proxy on 127.0.0.1:\(proxy.port)")
    var i = 0
    var cycle = 0
    while !stopped {
      cycle += 1
      let endpoint = proxies[i % proxies.count]
      let url = productUrls[i % productUrls.count]
      i += 1
      do {
        try runCycle(cycle, endpoint, url)
      } catch {
        if stopped { break }
        log("w\(index + 1): cycle \(cycle) failed: \(error.localizedDescription)")
      }
    }
    teardown()
  }

  private func runCycle(_ cycle: Int, _ endpoint: ProxyEndpoint, _ url: String) throws {
    proxy.setUpstream(endpoint)
    activeProxy = endpoint.raw
    pageUrl = url
    currentTcin = Self.tcin(from: url)
    clearIdentity()
    plusInjected = false
    if !originReady {
      log("Loading Product")
      try load(url, timeout: 20)
      originReady = true
    } else {
      injectAtcPlus()
    }
    _ = eval(Self.hookJs)
    if !preparePlus() {
      log("No ATC button")
      originReady = false
      return
    }
    var captured = 0
    var stalls = 0
    while captured < atcPerCycle && !stopped {
      let started = Date()
      let before = currentCaptures()
      let tapped = clickInContentAtc()
      log("Harvesting Cookie")
      if tapped && waitForCapture(before, captureWait) {
        captured += 1
        stalls = 0
      } else {
        stalls += 1
        _ = eval(Self.overlayJs)
        if !tapped { log("ATC tap blocked") }
        else { log("No cart POST") }
        if stalls >= 2 {
          log("w\(index + 1): cycle \(cycle) stalled; rotating")
          break
        }
      }
      let elapsed = Date().timeIntervalSince(started)
      if elapsed < minIter { Thread.sleep(forTimeInterval: minIter - elapsed) }
    }
  }

  private func preparePlus() -> Bool {
    if !waitSsx() { return false }
    _ = eval(Self.hookJs)
    _ = tryClick("[data-test='fulfillment-cell-shipping']")
    Thread.sleep(forTimeInterval: 0.15)
    let ready = eval("typeof window.__zynAddToCart==='function'?'true':'false'")
    return ready == "true"
  }

  private func waitSsx() -> Bool {
    let deadline = Date().addingTimeInterval(12)
    while Date() < deadline && !stopped {
      if eval("document.documentElement.getAttribute('data-ssx-ready')") == "true" { return true }
      Thread.sleep(forTimeInterval: 0.12)
    }
    return false
  }

  private func injectAtcPlus() {
    if stopped || plusInjected { return }
    plusInjected = true
    let html = AtcPlusTemplate.html(tcin: currentTcin)
    guard let data = try? JSONSerialization.data(withJSONObject: html, options: [.fragmentsAllowed]),
          let encoded = String(data: data, encoding: .utf8) else { return }
    let script = "document.open();document.write(\(encoded));document.close();'ok'"
    if Thread.isMainThread {
      webView?.evaluateJavaScript(script, completionHandler: nil)
      return
    }
    _ = eval(script)
  }

  private static func tcin(from url: String) -> String {
    guard let regex = try? NSRegularExpression(pattern: #"A-(\d+)"#),
          let match = regex.firstMatch(in: url, range: NSRange(url.startIndex..., in: url)),
          let range = Range(match.range(at: 1), in: url) else {
      return AtcPlusTemplate.defaultTcin
    }
    return String(url[range])
  }

  private func waitSettled() {
    let deadline = Date().addingTimeInterval(30)
    while Date() < deadline && !stopped {
      let loading = eval("(function(){var el=document.querySelector('div[role=\"status\"]');if(!el)return 'false';var h=el.outerHTML;return (h.indexOf('Still loading')!==-1||h.indexOf('Almost there')!==-1)?'true':'false';})()")
      if loading != "true" { return }
      Thread.sleep(forTimeInterval: 0.25)
    }
  }

  private func waitForAtc() -> Bool {
    let deadline = Date().addingTimeInterval(30)
    while Date() < deadline && !stopped {
      if atcCount() > 0 { return true }
      _ = eval(Self.overlayJs)
      Thread.sleep(forTimeInterval: 0.25)
    }
    return false
  }

  private func clickInContentAtc() -> Bool {
    let raw = eval("(function(){try{if(typeof window.__zynAddToCart==='function'){window.__zynAddToCart();return 'ok';}}catch(e){}var el=document.querySelector('[id^=addToCartButtonOrTextIdFor]');if(!el)return 'none';el.click();return 'click';})()")
    if raw == "none" || raw == "null" || raw.isEmpty { return false }
    log("ATC tap")
    return true
  }

  private func waitForCapture(_ before: Int, _ seconds: Double) -> Bool {
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline && !stopped {
      if currentCaptures() > before { return true }
      Thread.sleep(forTimeInterval: 0.1)
    }
    return currentCaptures() > before
  }

  private func atcCount() -> Int {
    let raw = eval(atcCandidatesJs())
    guard let data = raw.data(using: .utf8),
          let arr = try? JSONSerialization.jsonObject(with: data) as? [Any] else { return 0 }
    return arr.count
  }

  private func tryClick(_ selector: String) -> Bool {
    let exists = eval("!!document.querySelector(\(Self.quote(selector)))")
    guard exists == "true" else { return false }
    _ = eval("(function(){var e=document.querySelector(\(Self.quote(selector)));if(!e)return false;e.scrollIntoView({block:'center'});e.click();return true;})()")
    return true
  }

  private func createWebView() {
    HarvestWebKit.warm(lowData: lowData)
    let ruleList = HarvestWebKit.rulesIfLowData(lowData)
    onMain {
      let controller = WKUserContentController()
      controller.add(self, name: "zynHarvest")
      controller.addUserScript(WKUserScript(source: Self.hookJs, injectionTime: .atDocumentStart, forMainFrameOnly: false))
      controller.addUserScript(WKUserScript(source: Self.hookJs, injectionTime: .atDocumentEnd, forMainFrameOnly: false))
      if let ruleList { controller.add(ruleList) }
      let config = WKWebViewConfiguration()
      config.userContentController = controller
      config.processPool = HarvestWebKit.processPool
      let store = WKWebsiteDataStore.nonPersistent()
      if #available(iOS 17.0, *) {
        let port = NWEndpoint.Port(rawValue: UInt16(self.proxy.port))!
        let endpoint = NWEndpoint.hostPort(host: NWEndpoint.Host("127.0.0.1"), port: port)
        store.proxyConfigurations = [ProxyConfiguration(httpCONNECTProxy: endpoint)]
      }
      config.websiteDataStore = store
      config.defaultWebpagePreferences.allowsContentJavaScript = true
      config.allowsInlineMediaPlayback = false
      let tile = HarvestHost.tileSize
      let design = CGSize(width: 390, height: 844)
      let view = WKWebView(frame: CGRect(origin: .zero, size: design), configuration: config)
      view.navigationDelegate = self
      view.isOpaque = true
      view.alpha = 1
      view.isUserInteractionEnabled = false
      if #available(iOS 16.4, *) { view.isInspectable = true }
      let host = UIView(frame: CGRect(x: 0, y: 0, width: tile, height: tile))
      host.clipsToBounds = true
      host.addSubview(view)
      let scale = min(tile / design.width, tile / design.height)
      view.transform = CGAffineTransform(scaleX: scale, y: scale)
      view.center = CGPoint(x: tile / 2, y: tile / 2)
      HarvestHost.attach(host, index: self.index, total: self.total)
      self.webView = view
      self.hostView = host
    }
    Thread.sleep(forTimeInterval: 0.15)
  }

  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    guard message.name == "zynHarvest" else { return }
    var body: [String: Any] = [:]
    if let text = message.body as? String,
       let data = text.data(using: .utf8),
       let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
      body = obj
    } else if let dict = message.body as? [String: Any] {
      body = dict
    } else {
      return
    }
    let url = body["url"] as? String ?? ""
    var headers: [String: String] = [:]
    if let raw = body["headers"] as? [String: Any] {
      for (key, value) in raw { headers[key.lowercased()] = String(describing: value) }
    }
    let ua = headers["user-agent"] ?? self.userAgent
    if ua.isEmpty == false { headers["user-agent"] = ua }
    let hasShape = headers.keys.contains { $0.hasPrefix("x-g") || $0.contains("x-gyjwza5z") }
    if !hasShape {
      let keys = headers.keys.sorted().joined(separator: ",")
      log("No Shape headers")
      log("w\(index + 1): cart POST keys=\(keys.isEmpty ? "none" : keys)")
      return
    }
    callbacks.onCapture(headers, activeProxy, ua, pageUrl.isEmpty ? url : pageUrl)
    captureLock.lock()
    captureCount += 1
    totalHarvested += 1
    let total = totalHarvested
    captureLock.unlock()
    callbacks.onHarvested(total)
    log("Harvested Cookie")
  }

  func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
    if stopped { signalNav(); return }
    injectAtcPlus()
    signalNav()
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    if stopped { signalNav(); return }
    injectAtcPlus()
    signalNav()
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    signalNav()
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    signalNav()
  }

  func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    decisionHandler(.allow)
  }

  private func signalNav() {
    navLock.lock()
    navWaiter?.signal()
    navWaiter = nil
    navLock.unlock()
  }

  private func load(_ url: String, timeout: TimeInterval) throws {
    let waiter = DispatchSemaphore(value: 0)
    navLock.lock()
    navWaiter = waiter
    navLock.unlock()
    onMain {
      if self.stopped { return }
      if let target = URL(string: url) {
        self.webView?.load(URLRequest(url: target, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout))
      }
    }
    let deadline = Date().addingTimeInterval(timeout)
    while waiter.wait(timeout: .now() + 0.1) != .success {
      if stopped {
        throw NSError(domain: "HarvestWindow", code: 2, userInfo: [NSLocalizedDescriptionKey: "stopped"])
      }
      if Date() > deadline {
        throw NSError(domain: "HarvestWindow", code: 1, userInfo: [NSLocalizedDescriptionKey: "timed out loading"])
      }
    }
    if stopped {
      throw NSError(domain: "HarvestWindow", code: 2, userInfo: [NSLocalizedDescriptionKey: "stopped"])
    }
  }

  private func eval(_ script: String) -> String {
    if stopped { return "null" }
    var result = "null"
    let waiter = DispatchSemaphore(value: 0)
    let run: () -> Void = {
      if self.stopped { waiter.signal(); return }
      guard let webView = self.webView else { waiter.signal(); return }
      webView.evaluateJavaScript(script) { value, _ in
        if let value { result = String(describing: value) }
        waiter.signal()
      }
    }
    if Thread.isMainThread {
      run()
      let deadline = Date().addingTimeInterval(1.2)
      while waiter.wait(timeout: .now() + 0.05) != .success {
        if stopped || Date() > deadline { return "null" }
        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
      }
    } else {
      DispatchQueue.main.async(execute: run)
      let deadline = Date().addingTimeInterval(1.2)
      while waiter.wait(timeout: .now() + 0.05) != .success {
        if stopped || Date() > deadline { return "null" }
      }
    }
    if result.hasPrefix("Optional(") { result = String(result.dropFirst(9).dropLast()) }
    return result
  }

  private func clearIdentity() {
    if stopped { return }
    let waiter = DispatchSemaphore(value: 0)
    DispatchQueue.main.async {
      if self.stopped { waiter.signal(); return }
      let types = WKWebsiteDataStore.allWebsiteDataTypes()
      self.webView?.configuration.websiteDataStore.removeData(ofTypes: types, modifiedSince: Date.distantPast) {
        waiter.signal()
      }
    }
    let deadline = Date().addingTimeInterval(1)
    while waiter.wait(timeout: .now() + 0.05) != .success {
      if stopped || Date() > deadline { return }
    }
  }

  private func teardown() {
    DispatchQueue.global(qos: .utility).async {
      self.proxy.close()
    }
  }

  private func currentCaptures() -> Int {
    captureLock.lock()
    defer { captureLock.unlock() }
    return captureCount
  }

  private func log(_ text: String) { callbacks.onLog(text) }

  private func onMain(_ block: @escaping () -> Void) {
    if Thread.isMainThread { block(); return }
    if stopped { return }
    let waiter = DispatchSemaphore(value: 0)
    DispatchQueue.main.async { block(); waiter.signal() }
    _ = waiter.wait(timeout: .now() + 2)
  }

  private func parseRect(_ raw: String) -> [Double]? {
    guard let data = raw.data(using: .utf8),
          let arr = try? JSONSerialization.jsonObject(with: data) as? [Any],
          arr.count >= 4 else { return nil }
    return arr.prefix(4).compactMap { ($0 as? NSNumber)?.doubleValue ?? Double("\($0)") }
  }

  private func atcCandidatesJs() -> String {
    "(function(){var els=document.querySelectorAll(\(Self.quote(atcSelector)));var out=[];for(var i=0;i<els.length;i++){var r=els[i].getBoundingClientRect();if(r.top<\(stickyTop))continue;if(r.width<=0||r.height<=0)continue;out.push([r.left,r.top,r.right,r.bottom]);}return JSON.stringify(out);})()"
  }

  private static let clickAtcJs = """
  (function(){
    var sticky=60;
    var sel='button[class*=fullWidth][id^=addToCartButtonOrTextIdFor][aria-label^="Add to cart" i]';
    var hide=function(el){if(!el||!el.style)return;el.style.setProperty('pointer-events','none','important');el.style.setProperty('display','none','important');};
    ['[class*="styles_overlay"]','.ModalDrawer','[role="dialog"]','[data-test*="overlay"]'].forEach(function(s){
      document.querySelectorAll(s).forEach(hide);
    });
    var els=document.querySelectorAll(sel);
    var vis=[];
    for(var i=0;i<els.length;i++){
      var b=els[i].getBoundingClientRect();
      if(b.top>=sticky&&b.width>0&&b.height>0) vis.push(els[i]);
    }
    if(!vis.length) return 'none';
    var el=vis[Math.floor(Math.random()*vis.length)];
    el.scrollIntoView({block:'center'});
    var fiberKey=Object.keys(el).find(function(k){return k.indexOf('__reactFiber')===0||k.indexOf('__reactInternalInstance')===0;});
    var propsKey=Object.keys(el).find(function(k){return k.indexOf('__reactProps')===0||k.indexOf('__reactEventHandlers')===0;});
    var props=propsKey?el[propsKey]:null;
    if(!props && fiberKey && el[fiberKey]){
      var fiber=el[fiberKey];
      props=fiber.memoizedProps||(fiber.return&&fiber.return.memoizedProps)||null;
    }
    var ev={
      type:'click', bubbles:true, cancelable:true, isTrusted:true, target:el, currentTarget:el,
      nativeEvent:{isTrusted:true}, preventDefault:function(){}, stopPropagation:function(){}, persist:function(){}
    };
    try { if(props && typeof props.onClick==='function'){ props.onClick(ev); } } catch(e) {}
    try { el.click(); } catch(e) {}
    return 'ok';
  })()
  """

  private func reactClickJs(_ index: Int) -> String {
    """
    (function(){
      var els=document.querySelectorAll(\(Self.quote(atcSelector)));
      var vis=[];
      for(var i=0;i<els.length;i++){
        var b=els[i].getBoundingClientRect();
        if(b.top>=\(stickyTop)&&b.width>0&&b.height>0) vis.push(els[i]);
      }
      var el=vis[\(index)];
      if(!el) return 'none';
      el.scrollIntoView({block:'center'});
      var fiberKey=Object.keys(el).find(function(k){return k.indexOf('__reactFiber')===0||k.indexOf('__reactInternalInstance')===0;});
      var propsKey=Object.keys(el).find(function(k){return k.indexOf('__reactProps')===0||k.indexOf('__reactEventHandlers')===0;});
      var props=propsKey?el[propsKey]:null;
      if(!props && fiberKey && el[fiberKey]){
        var fiber=el[fiberKey];
        props=fiber.memoizedProps||(fiber.return&&fiber.return.memoizedProps)||null;
      }
      var ev={
        type:'click', bubbles:true, cancelable:true, isTrusted:true, target:el, currentTarget:el,
        nativeEvent:{isTrusted:true}, preventDefault:function(){}, stopPropagation:function(){}, persist:function(){}
      };
      try { if(props && typeof props.onClick==='function'){ props.onClick(ev); return 'onClick'; } } catch(e) {}
      try { if(props && typeof props.onPointerUp==='function'){ props.onPointerUp(ev); return 'onPointerUp'; } } catch(e) {}
      try { el.click(); return 'click'; } catch(e) { return 'fail'; }
    })()
    """
  }

  private func scrollAtcJs(_ index: Int) -> String {
    "(function(){var els=document.querySelectorAll(\(Self.quote(atcSelector)));var vis=[];for(var i=0;i<els.length;i++){var b=els[i].getBoundingClientRect();if(b.top>=\(stickyTop)&&b.width>0&&b.height>0)vis.push(els[i]);}var e=vis[\(index)];if(!e)return '[]';e.scrollIntoView({block:'center'});var r=e.getBoundingClientRect();return JSON.stringify([r.left,r.top,r.right,r.bottom]);})()"
  }

  private func elementAtPointJs(_ x: Double, _ y: Double) -> String {
    "(function(){var e=document.elementFromPoint(\(Int(x)),\(Int(y)));if(!e)return 'nothing';if(e.closest(\(Self.quote(atcSelector))))return 'ok';var c=(e.className&&e.className.split)?e.className.split(' ')[0]:'';return e.tagName+(c?'.'+c:'');})()"
  }

  private func tapJs(_ x: Double, _ y: Double) -> String {
    """
    (function(){
      var x=\(x), y=\(y);
      var el=document.elementFromPoint(x,y);
      if(!el) return 'nothing';
      var opts={bubbles:true,cancelable:true,composed:true,clientX:x,clientY:y,screenX:x,screenY:y,view:window};
      try { el.dispatchEvent(new PointerEvent('pointerdown',Object.assign({pointerType:'touch',pointerId:1,isPrimary:true},opts))); } catch (e) {}
      try { el.dispatchEvent(new PointerEvent('pointerup',Object.assign({pointerType:'touch',pointerId:1,isPrimary:true},opts))); } catch (e) {}
      try {
        var t={identifier:1,clientX:x,clientY:y,screenX:x,screenY:y,pageX:x,pageY:y,target:el};
        el.dispatchEvent(new TouchEvent('touchstart',{bubbles:true,cancelable:true,touches:[t],targetTouches:[t],changedTouches:[t]}));
        el.dispatchEvent(new TouchEvent('touchend',{bubbles:true,cancelable:true,touches:[],targetTouches:[],changedTouches:[t]}));
      } catch (e) {}
      try { el.dispatchEvent(new MouseEvent('mousedown',opts)); } catch (e) {}
      try { el.dispatchEvent(new MouseEvent('mouseup',opts)); } catch (e) {}
      try { el.dispatchEvent(new MouseEvent('click',opts)); } catch (e) {}
      try { el.click(); } catch (e) {}
      return 'ok';
    })()
    """
  }

  private static func quote(_ value: String) -> String {
    let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed])
    if let data, let text = String(data: data, encoding: .utf8) { return text }
    return "\"\""
  }

  private static let overlayJs = """
  (function(){
    var n=0;
    var hide=function(el){if(!el||!el.style)return;el.style.setProperty('pointer-events','none','important');el.style.setProperty('display','none','important');n++;};
    var sels=['[class*="styles_overlay"]','.ModalDrawer','[role="dialog"]','[data-test*="overlay"]','[data-test="errorContent"]','[data-test*="toast"]','[class*="Snackbar"]','[class*="addedToCart"]'];
    for(var s=0;s<sels.length;s++){
      var els=document.querySelectorAll(sels[s]);
      for(var i=0;i<els.length;i++) hide(els[i]);
    }
    return 'hid:'+n;
  })()
  """

  private static let hookJs = """
  (function(){
    var CART = 'web_checkouts/v1/cart_items';
    var LOGIN = 'credential_validations';
    function abs(url){
      try { return String(new URL(String(url||''), location.href).href); } catch (e) { return String(url||''); }
    }
    function interesting(url, method){
      if (String(method||'GET').toUpperCase() !== 'POST') return false;
      url = abs(url);
      return url.indexOf(CART) !== -1 || url.indexOf(LOGIN) !== -1;
    }
    function addHeaders(out, h){
      if (!h) return;
      try {
        if (typeof h.forEach === 'function') { h.forEach(function(v,k){ out[String(k).toLowerCase()]=String(v); }); return; }
      } catch (e) {}
      try {
        if (typeof h.entries === 'function') {
          var it = h.entries();
          for (var n = it.next(); !n.done; n = it.next()) out[String(n.value[0]).toLowerCase()]=String(n.value[1]);
          return;
        }
      } catch (e) {}
      if (typeof h === 'object') {
        for (var k in h) if (Object.prototype.hasOwnProperty.call(h,k)) out[String(k).toLowerCase()]=String(h[k]);
      }
    }
    function collect(input, init){
      var out = {};
      if (input && typeof input === 'object') addHeaders(out, input.headers);
      if (init) addHeaders(out, init.headers);
      return out;
    }
    function post(payload){
      try { window.webkit.messageHandlers.zynHarvest.postMessage(JSON.stringify(payload)); } catch (e) {}
    }
    function hasShape(headers){
      for (var k in headers) {
        k = String(k).toLowerCase();
        if (k.indexOf('x-g')===0 || k.indexOf('gyjwza')!==-1) return true;
      }
      return false;
    }
    function capture(url, method, headers){
      post({ type: 'capture', url: abs(url), method: String(method||'POST'), headers: headers || {} });
    }
    function installFetch(){
      var current = window.fetch;
      if (!current || current.__zynHook) return;
      var hooked = function(input, init){
        var url = typeof input === 'string' ? input : (input && input.url);
        var method = (init && init.method) || (input && input.method) || 'GET';
        var headers = collect(input, init);
        var cart = interesting(url, method);
        if (hasShape(headers) || cart) capture(url, method, headers);
        if (cart) return Promise.reject(new TypeError('Failed to fetch'));
        return current.apply(this, arguments);
      };
      hooked.__zynHook = true;
      window.fetch = hooked;
    }
    function installXhr(){
      var proto = XMLHttpRequest.prototype;
      if (proto.open && proto.open.__zynHook) return;
      var open = proto.open;
      var setHeader = proto.setRequestHeader;
      var send = proto.send;
      proto.open = function(method, url){
        this.__zyn = { method: method, url: url, headers: {} };
        return open.apply(this, arguments);
      };
      proto.open.__zynHook = true;
      proto.setRequestHeader = function(k,v){
        if (this.__zyn) this.__zyn.headers[String(k).toLowerCase()] = String(v);
        return setHeader.apply(this, arguments);
      };
      proto.send = function(){
        if (this.__zyn) {
          var cart = interesting(this.__zyn.url, this.__zyn.method);
          if (hasShape(this.__zyn.headers) || cart) capture(this.__zyn.url, this.__zyn.method, this.__zyn.headers);
          if (cart) {
            try { this.abort(); } catch (e) {}
            return;
          }
        }
        return send.apply(this, arguments);
      };
    }
    installFetch();
    installXhr();
    try { document.addEventListener('DOMContentLoaded', function(){ installFetch(); installXhr(); }); } catch (e) {}
    if (!window.__zynHookTimer) {
      window.__zynHookTimer = setInterval(function(){ installFetch(); installXhr(); }, 1500);
    }
    window.__zynHook = true;
  })();
  """
}

@propertyWrapper
struct Volatile<T> {
  private var value: T
  private let lock = NSLock()
  init(wrappedValue: T) { value = wrappedValue }
  var wrappedValue: T {
    get { lock.lock(); defer { lock.unlock() }; return value }
    set { lock.lock(); value = newValue; lock.unlock() }
  }
}
