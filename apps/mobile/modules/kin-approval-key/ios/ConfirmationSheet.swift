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

  private let window: UIWindow
  private let controller: ConfirmationController
  private weak var previousKeyWindow: UIWindow?
  private var observers: [NSObjectProtocol] = []
  private var onOutcome: ((Outcome) -> Void)?

  /// Shows the sheet at once. `onOutcome` is called exactly once, after the sheet is gone.
  init(scene: UIWindowScene, prompt: String, onOutcome: @escaping (Outcome) -> Void) {
    self.onOutcome = onOutcome
    previousKeyWindow = scene.keyWindow
    // An input accessory view lives in the keyboard's window, above every app window.
    for window in scene.windows { window.endEditing(true) }
    window = UIWindow(windowScene: scene)
    window.windowLevel = .alert + 1
    controller = ConfirmationController(prompt: prompt)
    window.rootViewController = controller

    controller.onCancel = { [weak self] in self?.finish(.canceled("Approval was canceled.")) }
    controller.onApprove = { [weak self] in
      guard let self else { return }
      finish(isUnobscured ? .approved : .obscured)
    }
    controller.onDisappear = { [weak self] in self?.finish(.canceled("The confirmation sheet closed.")) }
    let center = NotificationCenter.default
    let leaving: [(Notification.Name, AnyObject?)] = [
      (UIScene.didEnterBackgroundNotification, scene),
      (UIScene.didDisconnectNotification, scene),
      (UIApplication.didEnterBackgroundNotification, nil),
    ]
    for (name, object) in leaving {
      observers.append(center.addObserver(forName: name, object: object, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.finish(.canceled("The app left the foreground during approval.")) }
      })
    }
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

  private func finish(_ outcome: Outcome) {
    guard let onOutcome else { return }
    close()
    onOutcome(outcome)
  }

  /// Checked when Approve is tapped: this window is key and on top, and nothing sits over the card,
  /// whether another window, a view added to this one (react-native-screens' FullWindowOverlay
  /// joins the key window), or a controller presented over the sheet (RN's Alert presents there).
  private var isUnobscured: Bool {
    guard window.isKeyWindow, !window.isHidden, let scene = window.windowScene else { return false }
    let windowAbove = scene.windows.contains { other in
      other !== window && !other.isHidden && other.windowLevel >= window.windowLevel
    }
    return !windowAbove
      && window.subviews.last === controller.view
      && controller.view.subviews.last === controller.card
      && controller.presentedViewController == nil
  }
}

private final class ConfirmationController: UIViewController {
  var onApprove: (() -> Void)?
  var onCancel: (() -> Void)?
  var onDisappear: (() -> Void)?
  let card = UIView()
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
    let approve = UIButton(configuration: .filled(), primaryAction: UIAction(title: "Approve") { [weak self] _ in
      self?.onApprove?()
    })
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
