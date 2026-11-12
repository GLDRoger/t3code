// Opens one page in a WKWebView, the engine the iPhone app draws visuals with, until it is killed.
// With a second argument, that file's script runs first in every frame below the top one, as the
// app injects the prelude.
import AppKit
import WebKit

let arguments = CommandLine.arguments
guard arguments.count > 1, let url = URL(string: arguments[1]) else { exit(2) }
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let configuration = WKWebViewConfiguration()
configuration.websiteDataStore = .nonPersistent()
if arguments.count > 2, let source = try? String(contentsOfFile: arguments[2], encoding: .utf8) {
  configuration.userContentController.addUserScript(
    WKUserScript(
      source: "if(window.top!==window){\(source)}",
      injectionTime: .atDocumentStart,
      forMainFrameOnly: false))
}
let view = WKWebView(frame: NSRect(x: 0, y: 0, width: 800, height: 600), configuration: configuration)
// Off screen but in a window, so timers and loads run as they do on a phone.
let window = NSWindow(
  contentRect: NSRect(x: -4000, y: -4000, width: 800, height: 600), styleMask: [.borderless],
  backing: .buffered, defer: false)
window.contentView = view
window.orderFront(nil)
view.load(URLRequest(url: url))
app.run()
