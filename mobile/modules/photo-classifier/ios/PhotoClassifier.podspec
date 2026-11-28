require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

# Expo autolinking only finds a podspec one directory below the module root, so this file lives in ios/.
Pod::Spec.new do |s|
  s.name           = 'PhotoClassifier'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.homepage       = 'https://fitlogr.com'
  s.license        = 'MIT'
  s.author         = 'fitlogr'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/autoscale-david/app.fitlogr.com.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'Vision', 'Photos', 'UIKit'

  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '**/*.{h,m,mm,swift}'
end
