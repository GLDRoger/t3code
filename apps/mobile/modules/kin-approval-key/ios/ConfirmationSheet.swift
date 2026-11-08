import UIKit

/// The Face ID confirmation sheet, in a window the module owns above the app's own window, so the
/// app's JS can't draw over the grant text and leave the real Approve button exposed.
@MainActor
final class ConfirmationSheet {
  enum Outcome {
    case approved
    case obscured
    case canceled(String)
  }

  private enum Coverage {
    case clear
    case notKey
    case covered
  }

  /// How long the sheet must stay key and uncovered before Approve takes a tap, so a tap aimed at
  /// something JS drew (or the second tap of a double tap) can't land on it.
  private static let armDelay: CFTimeInterval = 0.7

  private let window: UIWindow
  private let controller: ConfirmationController
  private weak var previousKeyWindow: UIWindow?
  private var observers: [NSObjectProtocol] = []
  private var onOutcome: ((Outcome) -> Void)?
  private var armedAt = CFTimeInterval.infinity
  private var keyboardVisible = false

  /// Shows the sheet at once. `onOutcome` is called exactly once, after the sheet is gone.
  init(scene: UIWindowScene, prompt: String, onOutcome: @escaping (Outcome) -> Void) {
    self.onOutcome = onOutcome
    previousKeyWindow = scene.keyWindow
    window = UIWindow(windowScene: scene)
    window.windowLevel = .alert + 1
    controller = ConfirmationController(prompt: prompt)
    window.rootViewController = controller

    controller.onCancel = { [weak self] in self?.finish(.canceled("Approval was canceled.")) }
    controller.onApprove = { [weak self] in self?.approveTapped() }
    controller.onAppear = { [weak self] in self?.rearm() }
    controller.onDisappear = { [weak self] in self?.finish(.canceled("The confirmation sheet closed.")) }
    let leaving: [(Notification.Name, AnyObject?)] = [
      (UIScene.didEnterBackgroundNotification, scene),
      (UIScene.didDisconnectNotification, scene),
      (UIApplication.didEnterBackgroundNotification, nil),
    ]
    for (name, object) in leaving {
      observe(name, object) { $0.finish(.canceled("The app left the foreground during approval.")) }
    }
    let rearming: [(Notification.Name, AnyObject?)] = [
      (UIWindow.didBecomeKeyNotification, window),
      (UIWindow.didResignKeyNotification, window),
      (UIScene.willDeactivateNotification, scene),
      (UIScene.didActivateNotification, scene),
    ]
    for (name, object) in rearming { observe(name, object) { $0.rearm() } }
    // Before endEditing, so a keyboard that is up now reports its hide.
    observe(UIResponder.keyboardWillShowNotification, nil) { sheet in
      sheet.keyboardVisible = true
      sheet.rearm()
    }
    observe(UIResponder.keyboardDidHideNotification, nil) { sheet in
      sheet.keyboardVisible = false
      sheet.rearm()
    }
    // An input accessory view lives in the keyboard's window, above every app window.
    for window in scene.windows { window.endEditing(true) }
    window.makeKeyAndVisible()
  }

  /// Removes the sheet without an outcome; safe to call more than once.
  func close() {
    onOutcome = nil
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
    observers = []
    window.isHidden = true
    window.rootViewController = nil
    if let previousKeyWindow, !previousKeyWindow.isHidden { previousKeyWindow.makeKey() }
  }

  private func observe(_ name: Notification.Name, _ object: AnyObject?, _ body: @escaping (ConfirmationSheet) -> Void) {
    observers.append(NotificationCenter.default.addObserver(forName: name, object: object, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { if let self { body(self) } }
    })
  }

  private func finish(_ outcome: Outcome) {
    guard let onOutcome else { return }
    close()
    onOutcome(outcome)
  }

  /// Disables Approve and starts the arming delay again. Approve enables only if the sheet is
  /// still clear when the delay ends; a check that fails starts it over.
  private func rearm() {
    guard onOutcome != nil else { return }
    let deadline = CACurrentMediaTime() + Self.armDelay
    armedAt = deadline
    controller.approve.isEnabled = false
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.armDelay) { [weak self] in
      // A later rearm owns the timer.
      guard let self, onOutcome != nil, armedAt == deadline else { return }
      switch coverage {
      case .clear:
        controller.approve.isEnabled = true
      case .notKey:
        // RN's Alert.hide() leaves no key window. Take key back once; the delay starts over.
        window.makeKey()
        rearm()
      case .covered:
        rearm()
      }
    }
  }

  private func approveTapped() {
    // A disabled button gets no taps; this guards a tap already in flight when Approve disabled.
    guard controller.approve.isEnabled, CACurrentMediaTime() >= armedAt else { return }
    switch coverage {
    case .clear:
      finish(.approved)
    case .notKey:
      window.makeKey()
      rearm()
    case .covered:
      // Clear for the whole delay and covered at the tap: something appeared over the sheet.
      finish(.obscured)
    }
  }

  /// Whether the sheet could be covered right now: the keyboard is up, a controller is presented
  /// over the sheet (RN's Alert presents there), another window is at its level or above, or
  /// app-drawn views sit over the card (react-native-screens' FullWindowOverlay joins the key
  /// window).
  private var coverage: Coverage {
    guard !window.isHidden, let scene = window.windowScene else { return .covered }
    if keyboardVisible || controller.presentedViewController != nil { return .covered }
    let windowAbove = scene.windows.contains { other in
      other !== window && other.windowLevel >= window.windowLevel && Self.covers(other)
    }
    if windowAbove { return .covered }
    let views = window.subviews
    guard let index = views.lastIndex(where: { $0 === controller.view }) else { return .covered }
    if views[(index + 1)...].contains(where: Self.showsAppContent) { return .covered }
    if controller.view.subviews.drop(while: { $0 !== controller.card }).dropFirst().contains(where: Self.showsAppContent) {
      return .covered
    }
    return window.isKeyWindow ? .clear : .notKey
  }

  /// Hidden or transparent windows aren't drawn or hit-tested, and JS draws only with views, so a
  /// window without subviews shows nothing it controls. Keyboard host windows outlive the keyboard,
  /// which is tracked by notification instead, so they count only while they hold app views (an
  /// InputAccessoryView or OverKeyboardView left behind).
  private static func covers(_ other: UIWindow) -> Bool {
    guard !other.isHidden, other.alpha >= 0.01, !other.subviews.isEmpty else { return false }
    let name = NSStringFromClass(type(of: other))
    let keyboardHost = name.contains("RemoteKeyboardWindow") || name.contains("TextEffectsWindow")
    return !keyboardHost || showsAppContent(other)
  }

  /// Whether a visible part of this view tree is a class the app ships (React Native and module
  /// views) rather than one of UIKit's, such as the iPad pointer-hover container. JS can only
  /// draw through the app's own view classes.
  private static func showsAppContent(_ view: UIView) -> Bool {
    guard !view.isHidden, view.alpha >= 0.01 else { return false }
    if Bundle(for: type(of: view)).bundleURL.path.hasPrefix(appBundlePath) { return true }
    return view.subviews.contains(where: showsAppContent)
  }

  private static let appBundlePath = Bundle.main.bundleURL.path
}

private final class ConfirmationController: UIViewController {
  var onApprove: (() -> Void)?
  var onCancel: (() -> Void)?
  var onAppear: (() -> Void)?
  var onDisappear: (() -> Void)?
  let card = UIView()
  private(set) lazy var approve = UIButton(configuration: .filled(), primaryAction: UIAction(title: "Approve") { [weak self] _ in
    self?.onApprove?()
  })
  private let prompt: String
  private let scroll = UIScrollView()

  init(prompt: String) {
    self.prompt = prompt
    super.init(nibName: nil, bundle: nil)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { nil }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = UIColor.black.withAlphaComponent(0.4)
    view.maximumContentSizeCategory = .accessibilityLarge

    card.backgroundColor = .systemBackground
    card.layer.cornerRadius = 14
    card.layer.cornerCurve = .continuous
    card.accessibilityViewIsModal = true

    let title = label("Confirm approval", .headline)
    title.accessibilityTraits = .header
    let message = label(prompt, .body)
    scroll.addSubview(message)

    let cancel = UIButton(configuration: .gray(), primaryAction: UIAction(title: "Cancel") { [weak self] _ in
      self?.onCancel?()
    })
    approve.isEnabled = false
    let buttons = UIStackView(arrangedSubviews: [cancel, approve])
    buttons.spacing = 8
    buttons.distribution = .fillEqually

    let content = UIStackView(arrangedSubviews: [title, scroll, buttons])
    content.axis = .vertical
    content.spacing = 16
    content.translatesAutoresizingMaskIntoConstraints = false
    card.addSubview(content)
    card.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(card)

    let safe = view.safeAreaLayoutGuide
    // The text scrolls instead of clipping when it can't fit, so no fixed word is ever cut off.
    let fitText = scroll.heightAnchor.constraint(equalTo: scroll.contentLayoutGuide.heightAnchor)
    fitText.priority = .defaultHigh
    let preferredWidth = card.widthAnchor.constraint(equalToConstant: 320)
    preferredWidth.priority = .defaultHigh
    NSLayoutConstraint.activate([
      card.centerXAnchor.constraint(equalTo: safe.centerXAnchor),
      card.centerYAnchor.constraint(equalTo: safe.centerYAnchor),
      card.leadingAnchor.constraint(greaterThanOrEqualTo: safe.leadingAnchor, constant: 20),
      card.topAnchor.constraint(greaterThanOrEqualTo: safe.topAnchor, constant: 20),
      preferredWidth,
      content.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 20),
      content.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -20),
      content.topAnchor.constraint(equalTo: card.topAnchor, constant: 20),
      content.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -20),
      message.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor),
      message.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
      message.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
      message.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
      message.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor),
      fitText,
    ])
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    scroll.flashScrollIndicators()
    onAppear?()
    UIAccessibility.post(notification: .screenChanged, argument: card)
  }

  override func viewDidDisappear(_ animated: Bool) {
    super.viewDidDisappear(animated)
    onDisappear?()
  }

  private func label(_ text: String, _ style: UIFont.TextStyle) -> UILabel {
    let label = UILabel()
    label.text = text
    label.font = .preferredFont(forTextStyle: style)
    label.adjustsFontForContentSizeCategory = true
    label.numberOfLines = 0
    label.textAlignment = .center
    label.translatesAutoresizingMaskIntoConstraints = false
    return label
  }
}
