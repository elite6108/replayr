require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ReplayrExport'
  s.version        = package['version']
  s.summary        = 'On-device Replayr clip export'
  s.description    = 'Trims and encodes a Replayr clip on the phone.'
  s.license        = 'UNLICENSED'
  s.author         = 'Replayr'
  s.homepage       = 'https://www.replayr.tv'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/elite6108/replayr.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
