require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'PhotoClassifier'
  s.version        = package['version']
  s.summary        = 'On-device Vision classifier'
  s.homepage       = 'https://fitlogr.com'
  s.license        = 'MIT'
  s.author         = 'fitlogr'
  s.platforms      = { :ios => '16.4' }
  s.source         = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'Vision', 'Photos', 'UIKit'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = 'ios/**/*.{h,m,mm,swift}'
end
