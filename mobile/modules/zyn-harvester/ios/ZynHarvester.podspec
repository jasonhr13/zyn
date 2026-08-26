Pod::Spec.new do |s|
  s.name           = 'ZynHarvester'
  s.version        = '1.0.0'
  s.summary        = 'Zyn iOS Mode B Target harvester'
  s.description    = 'WKWebView harvest engine with local CONNECT proxy'
  s.author         = 'Zyn'
  s.homepage       = 'https://zynbot.app'
  s.license        = 'UNLICENSED'
  s.platforms      = { :ios => '17.0' }
  s.source         = { :git => 'https://github.com/zynbot/zyn.git' }
  s.static_framework = true
  s.swift_version  = '5.0'
  s.frameworks     = 'WebKit', 'Network', 'UIKit'
  s.dependency 'ExpoModulesCore'
  s.source_files = '*.{h,m,swift}'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
