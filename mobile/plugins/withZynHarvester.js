const { withAndroidManifest, withAppBuildGradle, withDangerousMod, withInfoPlist, withMainApplication } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(source, dest);
    else fs.copyFileSync(source, dest);
  }
}

module.exports = function withZynHarvester(config) {
  config = withInfoPlist(config, (mod) => {
    mod.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: 'Default Configuration',
            UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).SceneDelegate',
          },
        ],
      },
    };
    return mod;
  });
  config = withAppBuildGradle(config, (mod) => {
    if (!mod.modResults.contents.includes('androidx.webkit:webkit')) {
      mod.modResults.contents = mod.modResults.contents.replace(
        /dependencies\s*\{/,
        'dependencies {\n    implementation("androidx.webkit:webkit:1.12.1")',
      );
    }
    return mod;
  });
  config = withMainApplication(config, (mod) => {
    let contents = mod.modResults.contents;
    if (!contents.includes('HarvesterPackage')) {
      if (!contents.includes('import app.zynbot.mobile.harvester.HarvesterPackage')) {
        contents = contents.replace(
          'package app.zynbot.mobile',
          'package app.zynbot.mobile\n\nimport app.zynbot.mobile.harvester.HarvesterPackage',
        );
      }
      if (contents.includes('add(MyReactNativePackage())')) {
        contents = contents.replace(
          '// add(MyReactNativePackage())',
          'add(HarvesterPackage())',
        );
      } else if (contents.includes('addAll(PackageList(this).packages)')) {
        contents = contents.replace(
          'addAll(PackageList(this).packages)',
          'addAll(PackageList(this).packages)\n      add(HarvesterPackage())',
        );
      }
    }
    if (!contents.includes('HarvestProcesses')) {
      contents = contents.replace(
        'import app.zynbot.mobile.harvester.HarvesterPackage',
        'import app.zynbot.mobile.harvester.HarvestProcesses\nimport app.zynbot.mobile.harvester.HarvesterPackage',
      );
      contents = contents.replace(
        'override fun onCreate() {\n    super.onCreate()',
        'override fun onCreate() {\n    super.onCreate()\n    if (HarvestProcesses.isWorker(this)) return',
      );
    }
    mod.modResults.contents = contents;
    return mod;
  });
  config = withAndroidManifest(config, (mod) => {
    const application = mod.modResults.manifest.application && mod.modResults.manifest.application[0];
    if (application) {
      application.service = application.service || [];
      for (let index = 0; index < 6; index += 1) {
        const name = `.harvester.HarvestWorkerService${index}`;
        if (!application.service.some((service) => service.$ && service.$['android:name'] === name)) {
          application.service.push({
            $: {
              'android:name': name,
              'android:exported': 'false',
              'android:process': `:h${index}`,
            },
          });
        }
      }
    }
    return mod;
  });
  config = withDangerousMod(config, [
    'android',
    async (mod) => {
      const source = path.join(__dirname, '..', 'native', 'harvester');
      const dest = path.join(
        mod.modRequest.platformProjectRoot,
        'app/src/main/java/app/zynbot/mobile/harvester',
      );
      if (fs.existsSync(source)) copyTree(source, dest);
      return mod;
    },
  ]);
  config = withDangerousMod(config, [
    'ios',
    async (mod) => {
      const sceneSrc = path.join(__dirname, '..', 'native', 'ios', 'SceneDelegate.swift');
      const sceneDest = path.join(mod.modRequest.platformProjectRoot, 'Zyn', 'SceneDelegate.swift');
      if (fs.existsSync(sceneSrc)) {
        fs.mkdirSync(path.dirname(sceneDest), { recursive: true });
        fs.copyFileSync(sceneSrc, sceneDest);
      }
      const podfilePath = path.join(mod.modRequest.platformProjectRoot, 'Podfile');
      if (!fs.existsSync(podfilePath)) return mod;
      let contents = fs.readFileSync(podfilePath, 'utf8');
      if (!contents.includes("pod 'ZynHarvester'")) {
        contents = contents.replace(
          'use_expo_modules!',
          "use_expo_modules!\n  pod 'ZynHarvester', :path => '../modules/zyn-harvester/ios'",
        );
        fs.writeFileSync(podfilePath, contents);
      }
      const propsPath = path.join(mod.modRequest.platformProjectRoot, 'Podfile.properties.json');
      if (fs.existsSync(propsPath)) {
        const props = JSON.parse(fs.readFileSync(propsPath, 'utf8'));
        let changed = false;
        // Xcode 26 / iOS 27 SDK fails compiling RN from source (fmt consteval).
        if (props['ios.buildReactNativeFromSource'] !== 'false') {
          props['ios.buildReactNativeFromSource'] = 'false';
          changed = true;
        }
        if (props['ios.deploymentTarget'] !== '17.0') {
          props['ios.deploymentTarget'] = '17.0';
          changed = true;
        }
        if (changed) fs.writeFileSync(propsPath, `${JSON.stringify(props, null, 2)}\n`);
      }
      return mod;
    },
  ]);
  return config;
};
