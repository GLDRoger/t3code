Pod::Spec.new do |s|
  s.name = 'KinApprovalKey'
  s.version = '1.0.0'
  s.summary = 'Secure Enclave approval key for Kin grants.'
  s.author = 'Kin'
  s.homepage = 'https://github.com/GLDRoger/t3code'
  s.platform = :ios, '18.0'
  s.source = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '*.swift'
  s.frameworks = 'CryptoKit', 'DeviceCheck', 'LocalAuthentication', 'Security'
end
